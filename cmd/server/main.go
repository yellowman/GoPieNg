package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"net/http/fcgi"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/yellowman/gopieng/internal/auth"
	"github.com/yellowman/gopineg/internal/db"
	"github.com/yellwoman/gopieng/internal/middleware"
)

var (
	flagWeb       = flag.Bool("web", false, "Run as standalone HTTP server (default is FastCGI)")
	flagSocket    = flag.String("socket", "", "Unix socket path for FastCGI")
	flagNoStatic  = flag.Bool("no-static", false, "Disable static file serving (API only mode)")
	flagAddr      = flag.String("addr", "", "Listen address (overrides PIENG_ADDR)")
	flagWebRoot   = flag.String("webroot", "web", "Path to web directory")
	flagPingCheck = flag.Bool("ping-check", false, "Enable ping check for new IP allocations")
)

func main() {
	flag.Parse()

	// Environment config
	dsn := os.Getenv("PIENG_DSN")
	if dsn == "" {
		log.Fatal("PIENG_DSN is required")
	}

	addr := os.Getenv("PIENG_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080" // Default to localhost only
	}
	if *flagAddr != "" {
		addr = *flagAddr
	}

	secret := os.Getenv("PIENG_JWT_SECRET")
	if secret == "" {
		log.Fatal("PIENG_JWT_SECRET is required in production")
	}
	if len(secret) < 32 {
		log.Print("WARNING: JWT secret should be at least 32 characters")
	}

	// Open database
	database, err := db.Open(dsn)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer database.Close()

	// Configure connection pool for safety
	database.SetMaxOpenConns(25)
	database.SetMaxIdleConns(5)
	database.SetConnMaxLifetime(5 * time.Minute)

	jwt := auth.NewManager([]byte(secret))

	// Build router
	r := buildRouter(database, jwt, *flagNoStatic, *flagWebRoot, *flagPingCheck)

	// Pledge on OpenBSD (no-op on other systems)
	pledge()

	// Run server
	if *flagWeb {
		runHTTP(r, addr)
	} else {
		runFastCGI(r, *flagSocket, addr)
	}
}

func buildRouter(database *db.DB, jwt *auth.Manager, noStatic bool, webRoot string, pingCheck bool) *chi.Mux {
	r := chi.NewRouter()

	// Security middleware
	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(chimw.Logger)
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))
	r.Use(securityHeaders)
	r.Use(rateLimiter(100, time.Minute)) // 100 req/min per IP

	// CORS - restrictive by default
	allowedOrigins := strings.Split(os.Getenv("PIENG_CORS_ORIGINS"), ",")
	if len(allowedOrigins) == 1 && allowedOrigins[0] == "" {
		allowedOrigins = []string{} // No external origins by default
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   allowedOrigins,
		AllowedMethods:   []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		ExposedHeaders:   []string{"Link"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	// Health check (unauthenticated)
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		if err := database.Ping(); err != nil {
			http.Error(w, "db", 503)
			return
		}
		w.Write([]byte("ok"))
	})

	// Static files (unless disabled)
	if !noStatic {
		staticDir := filepath.Join(webRoot, "static")
		uiDir := filepath.Join(webRoot, "ui")

		r.Mount("/static/", http.StripPrefix("/static/",
			cacheControl(http.FileServer(http.Dir(staticDir)), "public, max-age=3600")))

		r.Get("/ui", spaIndex(filepath.Join(uiDir, "index.html")))
		r.Get("/ui/*", spaAssets(uiDir))

		// Redirect root to UI
		r.Get("/", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/ui", http.StatusFound)
		})
	}

	// API routes
	r.Route("/api/pieng", func(api chi.Router) {
		// Unauthenticated
		api.Post("/auth/login", auth.MakeLoginHandler(database.DB, jwt))
		api.Get("/ping", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"status":"ok"}`))
		})

		// Authenticated
		api.Group(func(priv chi.Router) {
			priv.Use(middleware.JWT(jwt))
			priv.Get("/me", auth.MeHandler(database.DB, jwt))
			priv.Mount("/", db.API(database.DB, jwt, pingCheck))
		})
	})

	return r
}

func runHTTP(r *chi.Mux, addr string) {
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadTimeout:       10 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 16, // 64KB
	}

	log.Printf("HTTP server listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func runFastCGI(r *chi.Mux, socket, addr string) {
	var listener net.Listener
	var err error

	if socket != "" {
		// Unix socket
		os.Remove(socket) // Clean up stale socket
		listener, err = net.Listen("unix", socket)
		if err != nil {
			log.Fatalf("fcgi socket: %v", err)
		}
		// Set permissions
		os.Chmod(socket, 0660)
		log.Printf("FastCGI listening on unix:%s", socket)
	} else {
		// TCP
		listener, err = net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("fcgi listen: %v", err)
		}
		log.Printf("FastCGI listening on %s", addr)
	}

	if err := fcgi.Serve(listener, r); err != nil {
		log.Fatalf("fcgi: %v", err)
	}
}

// Security headers middleware
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// Simple rate limiter per IP
func rateLimiter(limit int, window time.Duration) func(http.Handler) http.Handler {
	type client struct {
		count    int
		resetAt  time.Time
	}
	var mu sync.Mutex
	clients := make(map[string]*client)

	// Cleanup goroutine
	go func() {
		for {
			time.Sleep(window)
			mu.Lock()
			now := time.Now()
			for ip, c := range clients {
				if now.After(c.resetAt) {
					delete(clients, ip)
				}
			}
			mu.Unlock()
		}
	}()

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := r.RemoteAddr
			if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
				ip = strings.Split(fwd, ",")[0]
			}
			ip = strings.TrimSpace(ip)
			// Strip port
			if host, _, err := net.SplitHostPort(ip); err == nil {
				ip = host
			}

			mu.Lock()
			c, ok := clients[ip]
			now := time.Now()
			if !ok || now.After(c.resetAt) {
				c = &client{count: 0, resetAt: now.Add(window)}
				clients[ip] = c
			}
			c.count++
			count := c.count
			mu.Unlock()

			if count > limit {
				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// Cache control wrapper
func cacheControl(h http.Handler, value string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", value)
		h.ServeHTTP(w, r)
	})
}

func spaIndex(indexPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, indexPath)
	}
}

func spaAssets(uiDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/ui/")
		// Sanitize path
		p = filepath.Clean(p)
		if strings.HasPrefix(p, "..") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		fp := filepath.Join(uiDir, p)
		if _, err := os.Stat(fp); err == nil {
			// Set cache for assets
			if strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css") {
				w.Header().Set("Cache-Control", "public, max-age=3600")
			}
			http.ServeFile(w, r, fp)
			return
		}
		// Fallback to index for client routing
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(uiDir, "index.html"))
	}
}
