package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	passwordMemory  uint32 = 19 * 1024 // KiB; Argon2id, two passes, one lane.
	passwordTime    uint32 = 2
	passwordThreads uint8  = 1
)

var ErrPasswordBusy = errors.New("password service busy")
var passwordSlots = make(chan struct{}, 4)

func HashPassword(password string) (string, error) {
	if len(password) == 0 || len(password) > 1024 {
		return "", errors.New("invalid password length")
	}
	select {
	case passwordSlots <- struct{}{}:
		defer func() { <-passwordSlots }()
	default:
		return "", ErrPasswordBusy
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, passwordTime, passwordMemory, passwordThreads, 32)
	enc := base64.RawStdEncoding.EncodeToString
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s", argon2.Version, passwordMemory, passwordTime, passwordThreads, enc(salt), enc(key)), nil
}

// CheckPassword accepts legacy RFC2307 hashes as well as Argon2id PHC strings.
// Bound imported parameters and concurrent work before performing expensive
// hashing so malformed database entries cannot allocate unlimited memory.
func CheckPassword(stored, password string) (bool, error) {
	if len(password) > 1024 || len(stored) > 512 {
		return false, nil
	}
	if !strings.HasPrefix(stored, "$argon2id$") {
		return CheckRFC2307SSHA(stored, password), nil
	}
	p := strings.Split(stored, "$")
	if len(p) != 6 || p[2] != "v=19" {
		return false, nil
	}
	var memory, passes uint32
	var lanes uint8
	if n, err := fmt.Sscanf(p[3], "m=%d,t=%d,p=%d", &memory, &passes, &lanes); err != nil || n != 3 {
		return false, nil
	}
	if fmt.Sprintf("m=%d,t=%d,p=%d", memory, passes, lanes) != p[3] || lanes < 1 || lanes > 4 || memory < 8*uint32(lanes) || memory > 64*1024 || passes < 1 || passes > 4 {
		return false, nil
	}
	salt, err := base64.RawStdEncoding.DecodeString(p[4])
	if err != nil || len(salt) < 8 || len(salt) > 32 {
		return false, nil
	}
	expected, err := base64.RawStdEncoding.DecodeString(p[5])
	if err != nil || len(expected) != 32 {
		return false, nil
	}
	select {
	case passwordSlots <- struct{}{}:
		defer func() { <-passwordSlots }()
	default:
		return false, ErrPasswordBusy
	}
	actual := argon2.IDKey([]byte(password), salt, passes, memory, lanes, uint32(len(expected)))
	return subtle.ConstantTimeCompare(expected, actual) == 1, nil
}
