//go:build !unix

package main

import (
	"net"
)

// Daemonize is a no-op on non-Unix systems
func Daemonize() bool {
	return false
}

// PrivSep is a no-op on non-Unix systems
type PrivSep struct{}

func NewPrivSep(verbose bool) *PrivSep {
	return &PrivSep{}
}

func (ps *PrivSep) CreateSocket(socketPath string) (net.Listener, error) {
	return nil, nil
}

func (ps *PrivSep) DropPrivileges(socketPath string) error {
	return nil
}

func (ps *PrivSep) IsRoot() bool {
	return false
}
