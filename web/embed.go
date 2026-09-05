// Package web provides built-in assets that remain available after chroot.
package web

import (
	"bytes"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"time"
)

//go:embed index.html css/*.css js/*.js
var Assets embed.FS

// Load snapshots an optional external webroot before privilege drop. Never
// follow symlinks out of the selected tree. The default uses embedded assets.
func Load(dir string) (fs.FS, error) {
	if dir == "" {
		return Assets, nil
	}
	source := os.DirFS(dir)
	files := memoryFS{}
	var total int64
	err := fs.WalkDir(source, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return fmt.Errorf("webroot contains symlink: %s", path)
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("webroot contains non-regular file: %s", path)
		}
		total += info.Size()
		if total > 32<<20 {
			return fmt.Errorf("webroot exceeds 32 MiB")
		}
		data, err := fs.ReadFile(source, path)
		if err != nil {
			return err
		}
		files[path] = memoryEntry{data: data, name: d.Name(), modTime: info.ModTime()}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if _, err := fs.Stat(files, "index.html"); err != nil {
		return nil, fmt.Errorf("webroot needs index.html: %w", err)
	}
	return files, nil
}

// The HTTP server only opens explicit asset files; directory listings are not
// exposed by this in-memory filesystem.
type memoryEntry struct {
	data    []byte
	name    string
	modTime time.Time
}
type memoryFS map[string]memoryEntry

func (m memoryFS) Open(name string) (fs.File, error) {
	if !fs.ValidPath(name) {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrInvalid}
	}
	e, ok := m[name]
	if !ok {
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}
	return &memoryFile{Reader: bytes.NewReader(e.data), entry: e}, nil
}

type memoryFile struct {
	*bytes.Reader
	entry memoryEntry
}

func (f *memoryFile) Close() error               { return nil }
func (f *memoryFile) Stat() (fs.FileInfo, error) { return memoryInfo{f.entry}, nil }

type memoryInfo struct{ memoryEntry }

func (i memoryInfo) Name() string       { return i.name }
func (i memoryInfo) Size() int64        { return int64(len(i.data)) }
func (i memoryInfo) Mode() fs.FileMode  { return 0444 }
func (i memoryInfo) ModTime() time.Time { return i.modTime }
func (i memoryInfo) IsDir() bool        { return false }
func (i memoryInfo) Sys() any           { return nil }
