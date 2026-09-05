package web

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestAssetsSurviveRemovalOfExternalRoot(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("snapshot"), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "index.html")); err != nil {
		t.Fatal(err)
	}
	content, err := fs.ReadFile(f, "index.html")
	if err != nil || string(content) != "snapshot" {
		t.Fatal(string(content), err)
	}
}
func TestWebrootRejectsSymlinks(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink("/etc/passwd", filepath.Join(dir, "index.html")); err != nil {
		t.Skip(err)
	}
	if _, err := Load(dir); err == nil {
		t.Fatal("symlink accepted")
	}
}
