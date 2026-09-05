//go:build openbsd

package main

import "golang.org/x/sys/unix"

func pledge() error {
	// inet/dns/unix are required for database reconnections and bounded TCP
	// probes. rpath is still needed for resolver/TLS configuration. Embedded
	// assets do not require access to an external webroot after chroot.
	return unix.Pledge("stdio rpath cpath fattr inet dns unix", "")
}
