package manifest

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestTreeDigestCostOnTheRealBundle reports what the memo's stat fingerprint actually
// costs on the shipped bundle. It is skipped unless WAFFLED_BUNDLE points at one.
func TestTreeDigestCostOnTheRealBundle(t *testing.T) {
	root := os.Getenv("WAFFLED_BUNDLE")
	if root == "" {
		t.Skip("set WAFFLED_BUNDLE to a real bundle to measure the fingerprint")
	}
	m, err := Load(root)
	if err != nil {
		t.Fatal(err)
	}
	var last time.Duration
	for i := 0; i < 3; i++ {
		start := time.Now()
		if treeDigest(root, m) == "" {
			t.Fatal("empty digest")
		}
		last = time.Since(start)
		t.Logf("run %d: %d files + %d symlinks in %s", i, len(m.Files), len(m.Symlinks), last)
	}
	cachePath := filepath.Join(t.TempDir(), "bundle-verified.json")
	start := time.Now()
	if _, _, err := VerifyCached(root, cachePath); err != nil {
		t.Fatalf("the real bundle must verify: %v", err)
	}
	t.Logf("cold VerifyCached (full walk): %s", time.Since(start))
	start = time.Now()
	if _, cached, err := VerifyCached(root, cachePath); err != nil || !cached {
		t.Fatalf("the second call must hit the memo (cached=%v, err=%v)", cached, err)
	}
	t.Logf("warm VerifyCached (memo hit): %s", time.Since(start))
}
