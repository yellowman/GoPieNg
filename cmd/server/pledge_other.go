//go:build !openbsd

package main

func pledge() error { return nil }
