// Command waffled-runtime supervises a native Waffled server on this machine — the
// job Docker Compose does on Linux.
//
//	waffled-runtime start [--foreground] [--bundle DIR] [--data DIR]
//	waffled-runtime stop
//	waffled-runtime status [--json]
//	waffled-runtime logs [service] [-f] [-n N]
//	waffled-runtime doctor [--json]
//	waffled-runtime version
//
// It is a CLI first, deliberately: everything the menu-bar app does, support can ask
// someone to do in Terminal.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
	"github.com/kevinpsites/waffled/apps/runtime/internal/supervisor"
)

// version is stamped at build time (-ldflags "-X main.version=..."); the bundle's own
// component versions come from its manifest and are shown by `status`.
var version = "dev"

const usage = `waffled-runtime — the Waffled server supervisor

Usage:
  waffled-runtime start [flags]     start the stack (detaches unless --foreground)
  waffled-runtime stop [flags]      stop the stack, in reverse order
  waffled-runtime status [flags]    what is running, on which ports
  waffled-runtime logs [service]    show a service log (postgres, migrate, api, powersync, caddy, runtime)
  waffled-runtime doctor [flags]    diagnose a stack that will not start
  waffled-runtime version

Common flags:
  --bundle DIR   the runtime bundle (default: the directory above this binary)
  --data DIR     the data directory (default: ~/Library/Application Support/Waffled)

start:
  --foreground   run the supervisor in this process — what launchd and the Mac app use
stop:
  --timeout D    how long to wait for a graceful shutdown (default 2m)
status, doctor:
  --json         machine-readable output
logs:
  -f             follow
  -n N           lines to show (default 200)
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "✗ %v\n", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		fmt.Print(usage)
		return errors.New("no command given")
	}
	switch args[0] {
	case "start":
		return cmdStart(args[1:])
	case "stop":
		return cmdStop(args[1:])
	case "status":
		return cmdStatus(args[1:])
	case "logs":
		return cmdLogs(args[1:])
	case "doctor":
		return cmdDoctor(args[1:])
	case "version", "--version", "-v":
		fmt.Printf("waffled-runtime %s\n", version)
		return nil
	case "help", "--help", "-h":
		fmt.Print(usage)
		return nil
	default:
		fmt.Print(usage)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

type commonFlags struct {
	bundle string
	data   string
}

func addCommon(fs *flag.FlagSet) *commonFlags {
	c := &commonFlags{}
	fs.StringVar(&c.bundle, "bundle", "", "runtime bundle directory")
	fs.StringVar(&c.data, "data", "", "data directory")
	return c
}

// newSupervisor is where every command starts: it resolves the bundle, verifies it
// against its manifest, and settles config.env and the ports. A failure here is a
// failure to start, by design — nothing in the bundle runs until it matches what was
// built and signed.
func newSupervisor(c *commonFlags, log *supervisor.Logger) (*supervisor.Supervisor, error) {
	return supervisor.New(supervisor.Options{BundleDir: c.bundle, DataDir: c.data, Log: log})
}

// newInspector is newSupervisor for the read-only commands. They must still work when
// something has taken one of our ports — that is precisely when someone runs them — so
// a conflict becomes a reported fault rather than a refusal to start up at all.
func newInspector(c *commonFlags, log *supervisor.Logger) (*supervisor.Supervisor, error) {
	return supervisor.New(supervisor.Options{
		BundleDir: c.bundle, DataDir: c.data, Log: log, TolerateConflicts: true,
	})
}

func cmdStart(args []string) error {
	fs := flag.NewFlagSet("start", flag.ContinueOnError)
	common := addCommon(fs)
	foreground := fs.Bool("foreground", false, "run the supervisor in this process")
	if err := fs.Parse(args); err != nil {
		return err
	}

	log := supervisor.NewLogger(os.Stderr, false)
	s, err := newSupervisor(common, log)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if *foreground {
		return s.RunForeground(ctx)
	}

	// Detached: re-exec ourselves with --foreground in a new session, then wait until
	// the public port answers so this command returns only when the server is usable.
	if _, err := s.StartDetached(ctx, nil); err != nil {
		return err
	}
	fmt.Printf("Waffled is running → %s\n", s.LocalURL())
	if lan := s.LANURL(); lan != "" {
		fmt.Printf("On your network:     %s\n", lan)
	}
	return nil
}

func cmdStop(args []string) error {
	fs := flag.NewFlagSet("stop", flag.ContinueOnError)
	common := addCommon(fs)
	timeout := fs.Duration("timeout", 2*time.Minute, "how long to wait for a graceful shutdown")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s, err := newSupervisor(common, supervisor.NewLogger(os.Stderr, false))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), *timeout+30*time.Second)
	defer cancel()
	return s.StopDetached(ctx, *timeout)
}

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	common := addCommon(fs)
	asJSON := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	// Status must not narrate; it is parsed.
	s, err := newInspector(common, supervisor.NewLogger(os.Stderr, true))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	report := s.Status(ctx)
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(report)
	}
	fmt.Print(report.Text())
	return nil
}

func cmdDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	common := addCommon(fs)
	asJSON := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s, err := newInspector(common, supervisor.NewLogger(os.Stderr, true))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	checks := s.Doctor(ctx)
	if *asJSON {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(checks)
	}
	text, failed := supervisor.DoctorText(checks)
	fmt.Print(text)
	if failed {
		return errors.New("doctor found problems")
	}
	return nil
}

func cmdLogs(args []string) error {
	fs := flag.NewFlagSet("logs", flag.ContinueOnError)
	common := addCommon(fs)
	follow := fs.Bool("f", false, "follow the log")
	lines := fs.Int("n", 200, "number of lines to show")
	if err := fs.Parse(args); err != nil {
		return err
	}
	s, err := newInspector(common, supervisor.NewLogger(io.Discard, true))
	if err != nil {
		return err
	}
	layout := s.Plan().Layout

	name := fs.Arg(0)
	if name == "" {
		entries, err := os.ReadDir(layout.Logs)
		if err != nil {
			return fmt.Errorf("no logs yet in %s", layout.Logs)
		}
		fmt.Printf("logs in %s:\n", layout.Logs)
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".log") {
				info, _ := e.Info()
				size := int64(0)
				if info != nil {
					size = info.Size()
				}
				fmt.Printf("  %-12s %8.1f KB\n", strings.TrimSuffix(e.Name(), ".log"), float64(size)/1024)
			}
		}
		return nil
	}

	path := layout.LogPath(name)
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("no log for %q (try: %s, or runtime)", name,
			strings.Join(append(services.Order, services.Migrate), ", "))
	}
	return tailFile(path, *lines, *follow)
}

// tailFile prints the last n lines and, with follow, keeps printing as the file grows.
func tailFile(path string, n int, follow bool) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	all := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(all) > n {
		all = all[len(all)-n:]
	}
	for _, line := range all {
		fmt.Println(line)
	}
	if !follow {
		return nil
	}

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	offset, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	buf := make([]byte, 32*1024)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(250 * time.Millisecond):
		}
		st, err := os.Stat(path)
		if err != nil {
			continue
		}
		// A rotated or truncated file: start again from its beginning.
		if st.Size() < offset {
			offset = 0
			if _, err := f.Seek(0, io.SeekStart); err != nil {
				return err
			}
		}
		for {
			n, err := f.Read(buf)
			if n > 0 {
				os.Stdout.Write(buf[:n])
				offset += int64(n)
			}
			if err != nil || n == 0 {
				break
			}
		}
	}
}
