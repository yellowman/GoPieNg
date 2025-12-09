package auth

import (
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/subtle"
	"encoding/base64"
	"strings"
)

// MakeRFC2307SSHA creates an SSHA256 password hash
func MakeRFC2307SSHA(password string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	h := sha256.New()
	h.Write([]byte(password))
	h.Write(salt)
	digest := h.Sum(nil)
	return "{SSHA256}" + base64.StdEncoding.EncodeToString(append(digest, salt...))
}

func CheckRFC2307SSHA(stored, password string) bool {
	s := strings.TrimSpace(stored)
	if s == "" { return false }

	algo := ""
	switch {
	case strings.HasPrefix(s, "{SSHA}"):
		algo = "sha1";    s = strings.TrimPrefix(s, "{SSHA}")
	case strings.HasPrefix(s, "{SSHA256}"):
		algo = "sha256";  s = strings.TrimPrefix(s, "{SSHA256}")
	case strings.HasPrefix(s, "{SSHA512}"):
		algo = "sha512";  s = strings.TrimPrefix(s, "{SSHA512}")
	default:
		return false
	}

	// tolerate missing padding
	b64 := s
	if m := len(b64) % 4; m != 0 { b64 += strings.Repeat("=", 4-m) }
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		if raw, err = base64.RawStdEncoding.DecodeString(s); err != nil { return false }
	}

	check := func(sumLen int, sum func([]byte) []byte) bool {
		if len(raw) <= sumLen { return false }
		digest, salt := raw[:sumLen], raw[sumLen:]
		return subtle.ConstantTimeCompare(sum(salt), digest) == 1
	}

	switch algo {
	case "sha1":
		return check(sha1.Size, func(salt []byte) []byte {
			h := sha1.New(); h.Write([]byte(password)); h.Write(salt); return h.Sum(nil)
		})
	case "sha256":
		return check(sha256.Size, func(salt []byte) []byte {
			h := sha256.New(); h.Write([]byte(password)); h.Write(salt); return h.Sum(nil)
		})
	case "sha512":
		return check(sha512.Size, func(salt []byte) []byte {
			h := sha512.New(); h.Write([]byte(password)); h.Write(salt); return h.Sum(nil)
		})
	}
	return false
}
