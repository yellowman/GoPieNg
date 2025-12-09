//go:build !openbsd

package main

func pledge() {
	// No-op on non-OpenBSD systems
}
