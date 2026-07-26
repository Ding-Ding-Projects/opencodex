package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestUpdateTagDryRunPlansPackageManagerCommand(t *testing.T) {
	for _, test := range []struct{ installer, tag, want string }{
		{"npm", "latest", "npm install -g @bitkyc08/opencodex@latest"},
		{"bun", "preview", "bun add -g @bitkyc08/opencodex@preview"},
	} {
		t.Run(test.installer+"-"+test.tag, func(t *testing.T) {
			t.Setenv("OCX_INSTALLER", test.installer)
			var output bytes.Buffer
			if err := runUpdate(context.Background(), []string{"--tag", test.tag, "--dry-run"}, IO{Out: &output, Err: &output}); err != nil {
				t.Fatal(err)
			}
			if strings.TrimSpace(output.String()) != test.want {
				t.Fatalf("plan = %q", output.String())
			}
		})
	}
}

func TestUpdateRejectsUnknownTagWithoutExecution(t *testing.T) {
	if err := runUpdate(context.Background(), []string{"--tag", "nightly", "--dry-run"}, IO{Out: &bytes.Buffer{}, Err: &bytes.Buffer{}}); err == nil {
		t.Fatal("unknown update channel accepted")
	}
}
