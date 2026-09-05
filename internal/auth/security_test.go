package auth

import (
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestPasswordFormatsAndUpgrade(t *testing.T) {
	password := "correct horse battery staple"
	modern, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	again, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if modern == again || !strings.HasPrefix(modern, "$argon2id$") {
		t.Fatal("missing random salt or wrong format")
	}
	for _, hash := range []string{modern, MakeRFC2307SSHA(password)} {
		ok, err := CheckPassword(hash, password)
		if err != nil || !ok {
			t.Fatal("valid password rejected", err)
		}
		ok, err = CheckPassword(hash, "wrong")
		if err != nil || ok {
			t.Fatal("wrong password accepted", err)
		}
	}
}

func TestPasswordRejectsMalformedParameters(t *testing.T) {
	for _, hash := range []string{
		"$argon2id$", "$argon2id$v=19$m=4294967295,t=2,p=1$a$b",
		"$argon2id$v=19$m=19456,t=4294967295,p=1$a$b",
		"$argon2id$v=19$m=19456,t=2,p=0$a$b",
		"$argon2id$v=19$m=19456,t=2,p=1suffix$a$b",
		"$argon2id$v=18$m=19456,t=2,p=1$a$b", strings.Repeat("x", 1024),
	} {
		ok, err := CheckPassword(hash, "password")
		if ok || err != nil {
			t.Fatalf("malformed hash accepted: %s", hash)
		}
	}
}

func TestJWTRejectsInvalidClaimsAndAlgorithms(t *testing.T) {
	secret := []byte(strings.Repeat("k", 32))
	m := NewManager(secret)
	token, err := m.Sign(1, []string{"editor"}, "stored hash")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := m.Parse(token)
	if err != nil || parsed.UserID != 1 {
		t.Fatal(err)
	}
	if parsed.Session == "stored hash" || strings.Contains(token, "stored hash") {
		t.Fatal("stored hash exposed")
	}
	if m.sessionTag(1, "stored hash") == m.sessionTag(1, "changed hash") || m.sessionTag(1, "stored hash") == m.sessionTag(2, "stored hash") {
		t.Fatal("session is not bound to credential and user")
	}
	for _, tc := range []struct {
		name   string
		method jwt.SigningMethod
		modify func(jwt.MapClaims)
	}{
		{"wrong algorithm", jwt.SigningMethodHS384, func(c jwt.MapClaims) {}},
		{"missing expiry", jwt.SigningMethodHS256, func(c jwt.MapClaims) { delete(c, "exp") }},
		{"missing issued at", jwt.SigningMethodHS256, func(c jwt.MapClaims) { delete(c, "iat") }},
		{"expired", jwt.SigningMethodHS256, func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Minute).Unix() }},
		{"future issued", jwt.SigningMethodHS256, func(c jwt.MapClaims) { c["iat"] = time.Now().Add(time.Hour).Unix() }},
		{"invalid uid", jwt.SigningMethodHS256, func(c jwt.MapClaims) { c["uid"] = 0 }},
		{"unbound session", jwt.SigningMethodHS256, func(c jwt.MapClaims) { delete(c, "session") }},
		{"wrong issuer", jwt.SigningMethodHS256, func(c jwt.MapClaims) { c["iss"] = "other" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := jwt.MapClaims{"uid": 1, "roles": []string{"administrator"}, "session": "tag", "iss": "gopieng", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix()}
			tc.modify(c)
			s, err := jwt.NewWithClaims(tc.method, c).SignedString(secret)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := m.Parse(s); err == nil {
				t.Fatal("invalid JWT accepted")
			}
		})
	}
	if _, err := m.Parse(strings.Repeat(".", 8193)); err == nil {
		t.Fatal("oversized token accepted")
	}
}
