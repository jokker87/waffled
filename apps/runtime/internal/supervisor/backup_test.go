package supervisor

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kevinpsites/waffled/apps/runtime/internal/backup"
	"github.com/kevinpsites/waffled/apps/runtime/internal/datadir"
	"github.com/kevinpsites/waffled/apps/runtime/internal/rtstate"
	"github.com/kevinpsites/waffled/apps/runtime/internal/services"
)

// backupSupervisor builds the least Supervisor that Backup can be driven through without
// a bundle or a database. PGDATA holds no cluster, so the dump fails early and for a
// reason that needs nothing running — which is exactly the shape this file needs: what
// happens on the way OUT of a failed backup.
func backupSupervisor(t *testing.T) *Supervisor {
	t.Helper()
	root := t.TempDir()
	s := &Supervisor{
		log:   NewLogger(io.Discard, true),
		state: &rtstate.State{},
		plan:  services.Plan{Layout: datadir.At(root)},
	}
	if err := os.MkdirAll(s.plan.Layout.Backups, 0o700); err != nil {
		t.Fatal(err)
	}
	return s
}

// seedDumps writes n dump-shaped files, oldest first, and returns their paths.
func seedDumps(t *testing.T, dir string, n int) []string {
	t.Helper()
	var out []string
	at := time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC)
	for i := 0; i < n; i++ {
		p := filepath.Join(dir, backup.DumpName(at.Add(time.Duration(i)*24*time.Hour)))
		if err := os.WriteFile(p, []byte("not really a dump"), 0o600); err != nil {
			t.Fatal(err)
		}
		out = append(out, p)
	}
	return out
}

func dumpsIn(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if backup.IsDump(e.Name()) {
			out = append(out, e.Name())
		}
	}
	return out
}

// Retention must not be conditional on the dump succeeding.
//
// The failure it guards against is a full disk: pg_dump fails on ENOSPC, and if pruning
// only ever runs after a dump has landed, the one mechanism that frees space is never
// reached — so every following night fails identically, for good. Honouring `keep` is the
// contract whichever way the run ends.
func TestRetentionRunsEvenWhenTheDumpFails(t *testing.T) {
	s := backupSupervisor(t)
	dir := s.plan.Layout.Backups
	seedDumps(t, dir, 5)

	if _, err := s.Backup(context.Background(), BackupOptions{Keep: 2}); err == nil {
		t.Fatal("the backup succeeded; this test needs it to fail (there is no cluster)")
	}

	if got := dumpsIn(t, dir); len(got) != 2 {
		t.Errorf("%d dumps kept after a failed backup, want 2 — retention did not run, so a "+
			"disk that filled up can never free itself: %v", len(got), got)
	}
}

// The other half of the contract: retention deletes nothing it was not asked to. A failed
// run must never cost a household a backup that worked.
func TestRetentionKeepsEverythingWithinTheLimit(t *testing.T) {
	s := backupSupervisor(t)
	dir := s.plan.Layout.Backups
	seedDumps(t, dir, 3)

	if _, err := s.Backup(context.Background(), BackupOptions{Keep: 14}); err == nil {
		t.Fatal("the backup succeeded; this test needs it to fail")
	}

	if got := dumpsIn(t, dir); len(got) != 3 {
		t.Errorf("%d dumps left, want all 3 — a failed backup deleted a good one: %v", len(got), got)
	}
}

// A dump the operator named is theirs: --out means their directory, their filenames, and
// retention has no business pruning it.
func TestRetentionSkipsAnOperatorNamedDestination(t *testing.T) {
	s := backupSupervisor(t)
	dir := s.plan.Layout.Backups
	seedDumps(t, dir, 5)

	out := filepath.Join(t.TempDir(), "mine.dump")
	if _, err := s.Backup(context.Background(), BackupOptions{Out: out, Keep: 2}); err == nil {
		t.Fatal("the backup succeeded; this test needs it to fail")
	}

	if got := dumpsIn(t, dir); len(got) != 5 {
		t.Errorf("%d dumps left, want 5 — retention pruned the backups directory during a "+
			"run that was writing somewhere else entirely: %v", len(got), got)
	}
}
