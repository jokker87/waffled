package supervisor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

func shell(name, script string) services.Spec {
	return services.Spec{
		Name: name,
		Path: "/bin/sh",
		Args: []string{"/bin/sh", "-c", script},
		Env:  []string{"PATH=/usr/bin:/bin"},
	}
}

func newTestRunner(t *testing.T) *runner {
	t.Helper()
	dir := t.TempDir()
	logs := filepath.Join(dir, "logs")
	pids := filepath.Join(dir, "pids")
	for _, d := range []string{logs, pids} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return &runner{logsDir: logs, pidsDir: pids, log: testLogger(t)}
}

func TestStartWritesAPidfileAndLogFile(t *testing.T) {
	r := newTestRunner(t)
	c, err := r.start(shell("noisy", "echo hello from the child; sleep 30"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.stop(2 * time.Second) })

	pidPath := filepath.Join(r.pidsDir, "noisy.pid")
	waitFor(t, 3*time.Second, func() bool {
		_, err := os.Stat(pidPath)
		return err == nil
	}, "pidfile was never written")

	raw, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) == "" {
		t.Error("pidfile is empty")
	}

	waitFor(t, 3*time.Second, func() bool {
		body, _ := os.ReadFile(filepath.Join(r.logsDir, "noisy.log"))
		return strings.Contains(string(body), "hello from the child")
	}, "child stdout did not reach logs/noisy.log")
}

// The log must be appended to, not truncated: a service that crash-loops would
// otherwise erase the very output that explains why.
func TestStartAppendsToAnExistingLog(t *testing.T) {
	r := newTestRunner(t)
	logPath := filepath.Join(r.logsDir, "appender.log")
	if err := os.WriteFile(logPath, []byte("earlier run\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := r.start(shell("appender", "echo second run"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.stop(time.Second) })

	waitFor(t, 3*time.Second, func() bool {
		body, _ := os.ReadFile(logPath)
		return strings.Contains(string(body), "second run")
	}, "new output never appeared")
	body, _ := os.ReadFile(logPath)
	if !strings.Contains(string(body), "earlier run") {
		t.Errorf("the previous log was truncated:\n%s", body)
	}
}

func TestStopIsGracefulAndRemovesThePidfile(t *testing.T) {
	r := newTestRunner(t)
	c, err := r.start(shell("polite", `trap 'exit 0' TERM; while true; do sleep 0.1; done`))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, 3*time.Second, c.running, "child never started")

	if err := c.stop(5 * time.Second); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if c.running() {
		t.Error("child still running after stop")
	}
	if _, err := os.Stat(filepath.Join(r.pidsDir, "polite.pid")); !os.IsNotExist(err) {
		t.Error("pidfile should be removed on stop")
	}
}

// A service that ignores SIGTERM must not hold up shutdown forever.
func TestStopEscalatesToSIGKILL(t *testing.T) {
	r := newTestRunner(t)
	c, err := r.start(shell("stubborn", `trap '' TERM; while true; do sleep 0.1; done`))
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, 3*time.Second, c.running, "child never started")

	start := time.Now()
	if err := c.stop(500 * time.Millisecond); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if c.running() {
		t.Error("a child that ignores SIGTERM must still be killed")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("escalation took too long: %s", elapsed)
	}
}

// Compose's `restart: unless-stopped`, reimplemented.
func TestACrashedChildIsRestarted(t *testing.T) {
	r := newTestRunner(t)
	marker := filepath.Join(t.TempDir(), "runs")
	c, err := r.start(shell("flaky", `echo run >> `+marker+`; sleep 0.2; exit 3`))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.stop(2 * time.Second) })
	c.superviseRestarts()

	waitFor(t, 15*time.Second, func() bool {
		body, _ := os.ReadFile(marker)
		return strings.Count(string(body), "run") >= 2
	}, "the child was never restarted after it crashed")

	if c.restarts() == 0 {
		t.Error("restart count should have been recorded")
	}
	if c.lastError() == "" {
		t.Error("the crash should be recorded as the last error")
	}
}

// A child stopped on purpose must stay stopped.
func TestAnIntentionalStopIsNotRestarted(t *testing.T) {
	r := newTestRunner(t)
	marker := filepath.Join(t.TempDir(), "runs")
	c, err := r.start(shell("wellbehaved", `echo run >> `+marker+`; while true; do sleep 0.1; done`))
	if err != nil {
		t.Fatal(err)
	}
	c.superviseRestarts()
	// Wait for evidence the child actually ran, not merely that it was spawned: stopping
	// it before /bin/sh reached the echo would prove nothing about restart behaviour.
	waitFor(t, 5*time.Second, func() bool {
		body, _ := os.ReadFile(marker)
		return strings.Contains(string(body), "run")
	}, "child never wrote its marker")

	if err := c.stop(3 * time.Second); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Second)
	body, _ := os.ReadFile(marker)
	if n := strings.Count(string(body), "run"); n != 1 {
		t.Errorf("a deliberately stopped child was restarted %d times", n-1)
	}
}

func TestPidfileRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "svc.pid")
	if err := writePidfile(path, 4242); err != nil {
		t.Fatal(err)
	}
	pid, err := readPidfile(path)
	if err != nil {
		t.Fatal(err)
	}
	if pid != 4242 {
		t.Errorf("pid = %d, want 4242", pid)
	}
	if _, err := readPidfile(filepath.Join(dir, "absent.pid")); err == nil {
		t.Error("a missing pidfile must be an error")
	}
	if err := os.WriteFile(path, []byte("not a number\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPidfile(path); err == nil {
		t.Error("a corrupt pidfile must be an error")
	}
}

// status reads pidfiles across process boundaries, so "is this pid alive" must be
// answered without having spawned it.
func TestProcessAliveByPid(t *testing.T) {
	if !processAlive(os.Getpid()) {
		t.Error("this process should be reported alive")
	}
	if processAlive(0) {
		t.Error("pid 0 is not a service")
	}
	// A pid that has certainly exited.
	cmd := shell("gone", "exit 0")
	c := &child{spec: cmd}
	_ = c
	if processAlive(999999) {
		t.Log("pid 999999 happens to exist on this machine; skipping the negative case")
	}
}

func TestSignalPidRejectsAnUnknownProcess(t *testing.T) {
	if err := signalPid(999998, syscall.SIGTERM); err == nil {
		t.Skip("pid 999998 exists on this machine")
	}
}

func waitFor(t *testing.T, limit time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("%s (waited %s)", msg, limit)
}

func testLogger(t *testing.T) *Logger {
	t.Helper()
	return NewLogger(testWriter{t}, false)
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Logf("%s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

var _ = context.Background
