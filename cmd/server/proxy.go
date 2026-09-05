package main

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

func trustedProxyMiddleware(config string) (func(http.Handler) http.Handler, error) {
	trusted := []netip.Prefix{}
	for _, text := range strings.Split(config, ",") {
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		p, err := netip.ParsePrefix(text)
		if err != nil {
			a, e := netip.ParseAddr(text)
			if e != nil {
				return nil, fmt.Errorf("invalid trusted proxy %q", text)
			}
			a = a.Unmap()
			p = netip.PrefixFrom(a, a.BitLen())
		}
		trusted = append(trusted, p.Masked())
	}
	contains := func(a netip.Addr) bool {
		for _, p := range trusted {
			if p.Contains(a) {
				return true
			}
		}
		return false
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host := r.RemoteAddr
			if h, _, err := net.SplitHostPort(host); err == nil {
				host = h
			}
			peer, err := netip.ParseAddr(host)
			if err == nil && contains(peer.Unmap()) {
				chain := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
				client := peer.Unmap()
				valid := len(chain) <= 32
				// Walk away from our trusted peer, stopping at the first
				// untrusted hop. Ignore attacker-supplied leftmost values.
				for i := len(chain) - 1; valid && i >= 0 && contains(client); i-- {
					a, e := netip.ParseAddr(strings.TrimSpace(chain[i]))
					if e != nil {
						valid = false
						break
					}
					client = a.Unmap()
				}
				if valid {
					r.RemoteAddr = client.String()
				}
			} else {
				r.Header.Del("X-Forwarded-Proto")
			}
			next.ServeHTTP(w, r)
		})
	}, nil
}
