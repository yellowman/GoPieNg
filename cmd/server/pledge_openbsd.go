//go:build openbsd

package main

import "golang.org/x/sys/unix"

func pledge() {
	// After initialization, restrict to these promises:
	// stdio - basic I/O
	// rpath - read files (static assets)
	// inet - network
	// dns - DNS resolution (for database connections)
	// unix - Unix sockets (for FastCGI)
	//
	// Note: unveil should also be used to restrict filesystem access
	// but that requires knowing paths at compile time
	
	if err := unix.Pledge("stdio rpath inet dns unix", ""); err != nil {
		// Log but don't fail - pledge may not be available
		// in chroot or other restricted environments
	}
}
