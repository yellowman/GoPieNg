package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
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
	"github.com/yellowman/GoPieNg/internal/auth"
	"github.com/yellowman/GoPieNg/internal/db"
	"github.com/yellowman/GoPieNg/internal/middleware"
	webui "github.com/yellowman/GoPieNg/web"
)

var (
	flagWeb      = flag.Bool("web", false, "Run as standalone HTTP server (default is FastCGI)")
	flagSocket   = flag.String("socket", "", "Unix socket path for FastCGI")
	flagNoStatic = flag.Bool("no-static", false, "Disable static file serving (API only mode)")
	flagAddr     = flag.String("addr", "", "Listen address (overrides PIENG_ADDR)")
	flagWebRoot  = flag.String("webroot", "", "External web directory (default: embedded assets)")
	flagVerbose  = flag.Bool("v", false, "Verbose logging (always enabled in -web mode)")
	flagDebug    = flag.Bool("d", false, "Debug mode - run in foreground, don't daemonize")
	flagPidFile  = flag.String("P", "", "Write PID to file (for rc.d scripts)")
)

func main() {
	flag.Parse()

	// Validate configuration BEFORE daemonizing so errors are visible
	dsn := os.Getenv("PIENG_DSN")
	if dsn == "" {
		log.Fatal("PIENG_DSN is required")
	}

	secret := os.Getenv("PIENG_JWT_SECRET")
	if secret == "" {
		log.Fatal("PIENG_JWT_SECRET is required in production")
	}
	if len(secret) < 32 {
		log.Fatal("PIENG_JWT_SECRET must be at least 32 characters")
	}

	addr := os.Getenv("PIENG_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080" // Default to localhost only
	}
	if *flagAddr != "" {
		addr = *flagAddr
	}

	// Validate socket path if specified
	if *flagSocket != "" {
		socketDir := filepath.Dir(*flagSocket)
		if _, err := os.Stat(socketDir); os.IsNotExist(err) {
			log.Fatalf("socket directory does not exist: %s", socketDir)
		}
	}

	// Test database connection before daemonizing so errors are visible
	testDB, err := db.Open(dsn)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	testDB.Close()

	// Daemonize unless -d (debug) or -web mode
	// Config is validated, safe to background now
	if !*flagDebug && !*flagWeb {
		if Daemonize() {
			// Parent process exits
			os.Exit(0)
		}
		// Child continues
	}

	// Write PID file if requested (after daemonize so we get child PID)
	if *flagPidFile != "" {
		if err := os.WriteFile(*flagPidFile, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0644); err != nil {
			log.Fatalf("pidfile: %v", err)
		}
		// Clean up on exit
		defer os.Remove(*flagPidFile)
	}

	// Enable verbose logging in web mode or if -v flag is set
	verbose := *flagWeb || *flagVerbose

	// Initialize privilege separation (must be done early)
	privsep := NewPrivSep(verbose)

	// Open database connection for real (child process needs its own)
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
	r, err := buildRouter(database, jwt, *flagNoStatic, *flagWebRoot, verbose)
	if err != nil {
		log.Fatalf("router: %v", err)
	}

	// Create socket before dropping privileges (if socket mode)
	var listener net.Listener
	if !*flagWeb && *flagSocket != "" && privsep.IsRoot() {
		listener, err = privsep.CreateSocket(*flagSocket)
		if err != nil {
			log.Fatalf("create socket: %v", err)
		}
	}

	// Drop privileges if running as root
	if err := privsep.DropPrivileges(*flagSocket); err != nil {
		log.Fatalf("privsep: %v", err)
	}

	// Pledge on OpenBSD (no-op on other systems)
	if err := pledge(); err != nil {
		log.Fatalf("pledge: %v", err)
	}

	// Run server
	if *flagWeb {
		runHTTP(r, addr)
	} else {
		runFastCGI(r, *flagSocket, addr, verbose, listener)
	}
}

func buildRouter(database *db.DB, jwt *auth.Manager, noStatic bool, webRoot string, verbose bool) (*chi.Mux, error) {
	r := chi.NewRouter()

	// Security middleware
	r.Use(chimw.RequestID)
	proxy, err := trustedProxyMiddleware(os.Getenv("PIENG_TRUSTED_PROXIES"))
	if err != nil {
		return nil, err
	}
	r.Use(proxy)
	if verbose {
		r.Use(chimw.Logger)
	}
	r.Use(chimw.Recoverer)
	r.Use(chimw.Timeout(30 * time.Second))
	r.Use(securityHeaders)
	r.Use(rateLimiter(300, time.Minute)) // 300 req/min per IP

	// Installing chi/cors with an empty origin list means wildcard, not
	// disabled. Omit the middleware entirely unless explicitly configured.
	if config := strings.TrimSpace(os.Getenv("PIENG_CORS_ORIGINS")); config != "" {
		origins := strings.Split(config, ",")
		for i := range origins {
			origins[i] = strings.TrimSpace(origins[i])
		}
		r.Use(cors.Handler(cors.Options{
			AllowedOrigins:   origins,
			AllowedMethods:   []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
			AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
			AllowCredentials: true,
			MaxAge:           300,
		}))
	}

	// Health check (unauthenticated)
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		if err := database.PingContext(r.Context()); err != nil {
			http.Error(w, "db", 503)
			return
		}
		w.Write([]byte("ok"))
	})

	// Static files (unless disabled)
	if !noStatic {
		assets, err := webui.Load(webRoot)
		if err != nil {
			return nil, err
		}
		index, err := fs.ReadFile(assets, "index.html")
		if err != nil {
			return nil, err
		}
		static := cacheControl(http.FileServer(http.FS(assets)), "public, max-age=3600")
		r.Mount("/css/", static)
		r.Mount("/js/", static)
		indexHandler := func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(index))
		}
		r.Get("/", indexHandler)
		r.NotFound(indexHandler)
	}

	// API routes
	r.Route("/api/pieng", func(api chi.Router) {
		// Unauthenticated
		api.Use(func(next http.Handler) http.Handler { return cacheControl(next, "no-store") })
		api.With(rateLimiter(20, time.Minute)).Post("/auth/login", auth.MakeLoginHandler(database.DB, jwt))
		api.Get("/ping", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			var lastID int64
			if err := database.DB.QueryRowContext(r.Context(), `SELECT COALESCE(MAX(id),0) FROM changelog`).Scan(&lastID); err != nil {
				http.Error(w, "database unavailable", http.StatusServiceUnavailable)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"status": "ok", "last_change": lastID})
		})

		// Authenticated
		api.Group(func(priv chi.Router) {
			priv.Use(middleware.JWT(jwt, database.DB))
			priv.Get("/me", auth.MeHandler(database.DB, jwt))
			priv.Mount("/", db.API(database.DB, jwt))
		})
	})

	return r, nil
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

func runFastCGI(r *chi.Mux, socket, addr string, verbose bool, existingListener net.Listener) {
	var listener net.Listener
	var err error

	if existingListener != nil {
		// Use pre-created listener (from privsep)
		listener = existingListener
		if verbose {
			log.Printf("FastCGI listening on unix:%s", socket)
		}
	} else if socket != "" {
		// Unix socket (not pre-created, meaning not root)
		os.Remove(socket) // Clean up stale socket
		listener, err = net.Listen("unix", socket)
		if err != nil {
			log.Fatalf("fcgi socket: %v", err)
		}
		// Set permissions - group writable
		os.Chmod(socket, 0660)
		if verbose {
			log.Printf("FastCGI listening on unix:%s", socket)
		}
	} else {
		// TCP
		listener, err = net.Listen("tcp", addr)
		if err != nil {
			log.Fatalf("fcgi listen: %v", err)
		}
		if verbose {
			log.Printf("FastCGI listening on %s", addr)
		}
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
		count   int
		resetAt time.Time
	}
	var mu sync.Mutex
	clients := make(map[string]*client)

	lastCleanup := time.Now()
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := r.RemoteAddr

			ip = strings.TrimSpace(ip)
			// Strip port
			if host, _, err := net.SplitHostPort(ip); err == nil {
				ip = host
			}

			mu.Lock()
			now := time.Now()
			if now.Sub(lastCleanup) >= window {
				for key, c := range clients {
					if !now.Before(c.resetAt) {
						delete(clients, key)
					}
				}
				lastCleanup = now
			}
			c, ok := clients[ip]
			if !ok && len(clients) >= 10000 {
				mu.Unlock()
				http.Error(w, "rate limiter capacity reached", http.StatusTooManyRequests)
				return
			}
			if !ok || now.After(c.resetAt) {
				c = &client{count: 0, resetAt: now.Add(window)}
				clients[ip] = c
			}
			c.count++
			count := c.count
			mu.Unlock()

			if count > limit {
				w.Header().Set("Retry-After", fmt.Sprint(int(window.Seconds())))
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
