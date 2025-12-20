//go:build unix

package main

import (
	"fmt"
	"log"
	"log/syslog"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"syscall"
)

// Daemonize forks to background unless already daemonized
// Returns true if this is the parent (should exit), false if child (continue)
func Daemonize() bool {
	// Check if we're already the daemon child
	if os.Getenv("_GOPIENG_DAEMON") == "1" {
		// We're the child - redirect log to syslog
		if w, err := syslog.New(syslog.LOG_DAEMON|syslog.LOG_INFO, "gopieng"); err == nil {
			log.SetOutput(w)
			log.SetFlags(0) // syslog adds its own timestamp
		}
		return false
	}

	// Re-exec ourselves as daemon
	exe, err := os.Executable()
	if err != nil {
		log.Fatalf("daemonize: cannot find executable: %v", err)
	}

	// Prepare environment with daemon marker
	env := append(os.Environ(), "_GOPIENG_DAEMON=1")

	// Create the child process
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = env

	// Detach from terminal
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true, // Create new session
	}

	if err := cmd.Start(); err != nil {
		log.Fatalf("daemonize: %v", err)
	}

	// Parent exits, child continues
	return true
}

// PrivSep handles privilege separation for Unix systems
type PrivSep struct {
	isRoot      bool
	targetUser  *user.User
	targetGroup *user.Group
	socketGroup *user.Group
	chrootDir   string
	verbose     bool
}

// NewPrivSep creates a new privilege separation handler
func NewPrivSep(verbose bool) *PrivSep {
	ps := &PrivSep{
		isRoot:  os.Getuid() == 0,
		verbose: verbose,
	}

	if !ps.isRoot {
		return ps
	}

	// Find target user for privilege drop
	ps.targetUser = ps.findUser()
	if ps.targetUser == nil {
		log.Fatal("privsep: cannot find suitable user (_gopieng, _pieng, www, nobody)")
	}

	// Find target group (same as user's primary group)
	gid := ps.targetUser.Gid
	ps.targetGroup, _ = user.LookupGroupId(gid)

	// Find socket group (for web server access)
	ps.socketGroup = ps.findSocketGroup()

	// Determine chroot directory
	ps.chrootDir = os.Getenv("PIENG_CHROOT")

	if ps.verbose {
		log.Printf("privsep: running as root, will drop to user=%s group=%s",
			ps.targetUser.Username, ps.groupName(ps.targetGroup))
		if ps.socketGroup != nil {
			log.Printf("privsep: socket group=%s", ps.socketGroup.Name)
		}
	}

	return ps
}

// findUser finds a suitable unprivileged user
func (ps *PrivSep) findUser() *user.User {
	// Check environment override first
	if envUser := os.Getenv("PIENG_USER"); envUser != "" {
		if u, err := user.Lookup(envUser); err == nil {
			return u
		}
		log.Printf("privsep: PIENG_USER=%s not found", envUser)
	}

	// Try standard daemon users in order of preference
	for _, name := range []string{"_gopieng", "_pieng", "www", "nobody"} {
		if u, err := user.Lookup(name); err == nil {
			return u
		}
	}
	return nil
}

// findSocketGroup finds the group for socket ownership
func (ps *PrivSep) findSocketGroup() *user.Group {
	// Check environment override first
	if envGroup := os.Getenv("PIENG_SOCKET_GROUP"); envGroup != "" {
		if g, err := user.LookupGroup(envGroup); err == nil {
			return g
		}
		log.Printf("privsep: PIENG_SOCKET_GROUP=%s not found", envGroup)
	}

	// Try www group (standard for web servers)
	if g, err := user.LookupGroup("www"); err == nil {
		return g
	}

	// Try www-data (Debian/Ubuntu)
	if g, err := user.LookupGroup("www-data"); err == nil {
		return g
	}

	return nil
}

func (ps *PrivSep) groupName(g *user.Group) string {
	if g == nil {
		return "(none)"
	}
	return g.Name
}

// CreateSocket creates and configures the Unix socket before dropping privileges
// Must be called before DropPrivileges if using socket mode
func (ps *PrivSep) CreateSocket(socketPath string) (net.Listener, error) {
	if socketPath == "" {
		return nil, fmt.Errorf("no socket path")
	}

	// Clean up stale socket
	os.Remove(socketPath)

	// Create socket
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("listen unix %s: %w", socketPath, err)
	}

	// Set socket permissions and ownership
	if err := ps.configureSocket(socketPath); err != nil {
		listener.Close()
		return nil, err
	}

	return listener, nil
}

// configureSocket sets up socket permissions and group ownership
func (ps *PrivSep) configureSocket(socketPath string) error {
	// Set permissions: owner rw, group rw, other none (0660)
	if err := os.Chmod(socketPath, 0660); err != nil {
		return fmt.Errorf("chmod socket: %w", err)
	}

	if ps.isRoot {
		// Set ownership to target user and socket group
		uid, _ := strconv.Atoi(ps.targetUser.Uid)
		gid := -1 // Keep current group if no socket group

		if ps.socketGroup != nil {
			gid, _ = strconv.Atoi(ps.socketGroup.Gid)
		} else if ps.targetGroup != nil {
			gid, _ = strconv.Atoi(ps.targetGroup.Gid)
		}

		if err := os.Chown(socketPath, uid, gid); err != nil {
			return fmt.Errorf("chown socket: %w", err)
		}

		if ps.verbose {
			log.Printf("privsep: socket %s uid=%d gid=%d mode=0660", socketPath, uid, gid)
		}
	}

	return nil
}

// DropPrivileges performs chroot and drops to unprivileged user
// Must be called after CreateSocket and after database connection is established
func (ps *PrivSep) DropPrivileges(socketPath string) error {
	if !ps.isRoot {
		if ps.verbose {
			log.Printf("privsep: not running as root, skipping privilege drop")
		}
		return nil
	}

	// Determine chroot directory
	chrootDir := ps.chrootDir
	if chrootDir == "" {
		if socketPath != "" {
			// Use socket's parent directory
			chrootDir = filepath.Dir(socketPath)
		} else {
			// Use /var/empty as fallback
			chrootDir = "/var/empty"
		}
	}

	// Ensure chroot directory exists
	if _, err := os.Stat(chrootDir); os.IsNotExist(err) {
		log.Printf("privsep: chroot directory %s does not exist, skipping chroot", chrootDir)
		chrootDir = ""
	}

	// Perform chroot if we have a directory
	if chrootDir != "" {
		if ps.verbose {
			log.Printf("privsep: chroot to %s", chrootDir)
		}
		if err := syscall.Chroot(chrootDir); err != nil {
			return fmt.Errorf("chroot %s: %w", chrootDir, err)
		}
		if err := os.Chdir("/"); err != nil {
			return fmt.Errorf("chdir /: %w", err)
		}
	}

	// Get numeric IDs
	uid, err := strconv.Atoi(ps.targetUser.Uid)
	if err != nil {
		return fmt.Errorf("parse uid: %w", err)
	}
	gid, err := strconv.Atoi(ps.targetUser.Gid)
	if err != nil {
		return fmt.Errorf("parse gid: %w", err)
	}

	// Drop supplementary groups
	if err := syscall.Setgroups([]int{gid}); err != nil {
		// Not fatal on all systems
		if ps.verbose {
			log.Printf("privsep: setgroups failed (may be ok): %v", err)
		}
	}

	// Drop group privileges first (must be done before dropping user)
	if err := syscall.Setgid(gid); err != nil {
		return fmt.Errorf("setgid %d: %w", gid, err)
	}

	// Drop user privileges
	if err := syscall.Setuid(uid); err != nil {
		return fmt.Errorf("setuid %d: %w", uid, err)
	}

	// Verify we actually dropped privileges
	if os.Getuid() == 0 || os.Geteuid() == 0 {
		return fmt.Errorf("failed to drop root privileges")
	}

	if ps.verbose {
		if chrootDir != "" {
			log.Printf("privsep: chrooted to %s, dropped to uid=%d gid=%d", chrootDir, uid, gid)
		} else {
			log.Printf("privsep: dropped to uid=%d gid=%d", uid, gid)
		}
	}

	return nil
}

// IsRoot returns true if running as root
func (ps *PrivSep) IsRoot() bool {
	return ps.isRoot
}
