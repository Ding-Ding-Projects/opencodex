package providers

import "testing"

func TestBaseProviderLabel(t *testing.T) {
	cases := map[string]string{"chatgpt": "openai", "openai-multi": "openai", "openai-main": "openai", "chatgpt-pabcdef": "openai", "xai-custom": "xai-custom"}
	for in, want := range cases {
		if got := BaseProviderLabel(in); got != want {
			t.Errorf("%s => %s want %s", in, got, want)
		}
	}
}
