package service

import (
	"strings"
	"testing"
)

const (
	testWscript  = `C:\Windows\System32\wscript.exe`
	testLauncher = `C:\Users\Test User\.opencodex\opencodex-proxy-launcher.vbs`
)

func healthyTaskXML() string {
	return `<Task>
  <RegistrationInfo><Description>OpenCodex proxy service</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions><Exec><Command>` + TaskXmlString(testWscript) + `</Command><Arguments>` + TaskXmlString(`/b /nologo "`+testLauncher+`"`) + `</Arguments></Exec></Actions>
</Task>`
}

func TestTaskXmlWithoutCommentsAndCdata(t *testing.T) {
	xml := `<Task><!-- <Data>comment</Data> --><![CDATA[<Data>cdata</Data>]]><Settings /></Task>`
	got := TaskXmlWithoutCommentsAndCdata(xml)
	if strings.Contains(got, "Data") || !strings.Contains(got, "<Settings />") {
		t.Fatalf("unexpected scrubbed XML: %q", got)
	}
}

func TestTaskXmlStringUsesCanonicalEntities(t *testing.T) {
	got := TaskXmlString(`<a value="x&y">'z'</a>`)
	want := `&lt;a value=&quot;x&amp;y&quot;&gt;&apos;z&apos;&lt;/a&gt;`
	if got != want {
		t.Fatalf("TaskXmlString() = %q, want %q", got, want)
	}
}

func TestTaskXmlElementCountUsesElementBoundaries(t *testing.T) {
	xml := `<Enabled>true</Enabled><Enabled attr="x" /><EnabledExtra /><x:Enabled />`
	if got := TaskXmlElementCount(xml, "Enabled"); got != 2 {
		t.Fatalf("TaskXmlElementCount() = %d, want 2", got)
	}
}

func TestTaskXmlHasPrefixedTag(t *testing.T) {
	if !TaskXmlHasPrefixedTag(`<task:Enabled>false</task:Enabled>`, "Enabled") {
		t.Fatal("expected namespace-prefixed tag to be detected")
	}
	if TaskXmlHasPrefixedTag(`<Enabled>true</Enabled>`, "Enabled") {
		t.Fatal("unprefixed tag was reported as prefixed")
	}
}

func TestTaskXmlOptionalValueEquals(t *testing.T) {
	tests := []struct {
		name string
		xml  string
		want bool
	}{
		{name: "omitted uses default", xml: "", want: true},
		{name: "matching value", xml: `<Enabled>true</Enabled>`, want: true},
		{name: "matching value ignores case and whitespace", xml: `<Enabled> TRUE </Enabled>`, want: true},
		{name: "wrong value", xml: `<Enabled>false</Enabled>`, want: false},
		{name: "duplicate value", xml: `<Enabled>true</Enabled><Enabled>true</Enabled>`, want: false},
		{name: "self closing value", xml: `<Enabled />`, want: false},
		{name: "prefixed value fails closed", xml: `<t:Enabled>true</t:Enabled>`, want: false},
		{name: "element boundary", xml: `<EnabledExtra>false</EnabledExtra>`, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := TaskXmlOptionalValueEquals(test.xml, "Enabled", "true"); got != test.want {
				t.Fatalf("TaskXmlOptionalValueEquals() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestWindowsTaskRegistrationHealthy(t *testing.T) {
	healthy := healthyTaskXML()
	tests := []struct {
		name string
		xml  string
		want bool
	}{
		{name: "healthy registration", xml: healthy, want: true},
		{
			name: "comment decoy cannot satisfy required value",
			xml: strings.Replace(healthy, `<LogonType>InteractiveToken</LogonType>`,
				`<!-- <LogonType>InteractiveToken</LogonType> --><LogonType>Password</LogonType>`, 1),
			want: false,
		},
		{
			name: "CDATA decoy cannot satisfy required value",
			xml: strings.Replace(healthy, `<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
				`<![CDATA[<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>]]><ExecutionTimeLimit>PT1H</ExecutionTimeLimit>`, 1),
			want: false,
		},
		{name: "Data block rejected", xml: strings.Replace(healthy, `<RegistrationInfo>`, `<Data><Settings><Enabled>true</Enabled></Settings></Data><RegistrationInfo>`, 1), want: false},
		{name: "prefixed Data block rejected", xml: strings.Replace(healthy, `<RegistrationInfo>`, `<x:Data /><RegistrationInfo>`, 1), want: false},
		{name: "prefixed optional tag fails closed", xml: strings.Replace(healthy, `<Enabled>true</Enabled><ExecutionTimeLimit>`, `<x:Enabled>true</x:Enabled><ExecutionTimeLimit>`, 1), want: false},
		{
			name: "omitted schema defaults are healthy",
			xml: strings.NewReplacer(
				`<LogonTrigger><Enabled>true</Enabled></LogonTrigger>`, `<LogonTrigger></LogonTrigger>`,
				`<RunLevel>LeastPrivilege</RunLevel>`, ``,
				`<Enabled>true</Enabled><ExecutionTimeLimit>`, `<ExecutionTimeLimit>`,
			).Replace(healthy),
			want: true,
		},
		{name: "explicit disabled trigger", xml: strings.Replace(healthy, `<LogonTrigger><Enabled>true</Enabled>`, `<LogonTrigger><Enabled>false</Enabled>`, 1), want: false},
		{name: "wrong run level", xml: strings.Replace(healthy, `LeastPrivilege`, `HighestAvailable`, 1), want: false},
		{name: "explicit disabled settings", xml: strings.Replace(healthy, `<Enabled>true</Enabled><ExecutionTimeLimit>`, `<Enabled>false</Enabled><ExecutionTimeLimit>`, 1), want: false},
		{name: "wrong logon type", xml: strings.Replace(healthy, `InteractiveToken`, `Password`, 1), want: false},
		{name: "wrong multiple instances policy", xml: strings.Replace(healthy, `IgnoreNew`, `Parallel`, 1), want: false},
		{name: "wrong execution time limit", xml: strings.Replace(healthy, `PT0S`, `PT1H`, 1), want: false},
		{name: "duplicate optional value", xml: strings.Replace(healthy, `<Enabled>true</Enabled><ExecutionTimeLimit>`, `<Enabled>true</Enabled><Enabled>false</Enabled><ExecutionTimeLimit>`, 1), want: false},
		{name: "wrong command", xml: strings.Replace(healthy, TaskXmlString(testWscript), TaskXmlString(`C:\Windows\System32\cscript.exe`), 1), want: false},
		{name: "wrong arguments", xml: strings.Replace(healthy, `/b /nologo`, `/nologo`, 1), want: false},
		{name: "self closing logon trigger uses defaults", xml: strings.Replace(healthy, `<LogonTrigger><Enabled>true</Enabled></LogonTrigger>`, `<LogonTrigger />`, 1), want: true},
		{
			name: "LogonTrigger outside Triggers does not count",
			xml: strings.Replace(strings.Replace(healthy, `<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>`, `<Triggers></Triggers>`, 1),
				`<RegistrationInfo>`, `<RegistrationInfo><LogonTrigger />`, 1),
			want: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := WindowsTaskRegistrationHealthy(test.xml, testWscript, testLauncher); got != test.want {
				t.Fatalf("WindowsTaskRegistrationHealthy() = %v, want %v\n%s", got, test.want, test.xml)
			}
		})
	}
}

func TestReadWindowsSchedulerXmlState(t *testing.T) {
	t.Run("not installed", func(t *testing.T) {
		state := ReadWindowsSchedulerXmlState("", testWscript, testLauncher)
		if state.Installed || state.Enabled || state.RegistrationHealthy {
			t.Fatalf("unexpected state: %+v", state)
		}
	})

	t.Run("installed healthy and enabled", func(t *testing.T) {
		state := ReadWindowsSchedulerXmlState(healthyTaskXML(), testWscript, testLauncher)
		if !state.Installed || !state.Enabled || !state.RegistrationHealthy {
			t.Fatalf("unexpected state: %+v", state)
		}
	})

	t.Run("omitted enabled uses default", func(t *testing.T) {
		xml := strings.Replace(healthyTaskXML(), `<Enabled>true</Enabled><ExecutionTimeLimit>`, `<ExecutionTimeLimit>`, 1)
		state := ReadWindowsSchedulerXmlState(xml, testWscript, testLauncher)
		if !state.Enabled || !state.RegistrationHealthy {
			t.Fatalf("unexpected state: %+v", state)
		}
	})

	t.Run("Data fails closed", func(t *testing.T) {
		xml := strings.Replace(healthyTaskXML(), `<RegistrationInfo>`, `<Data /><RegistrationInfo>`, 1)
		state := ReadWindowsSchedulerXmlState(xml, testWscript, testLauncher)
		if !state.Installed || state.Enabled || state.RegistrationHealthy {
			t.Fatalf("unexpected state: %+v", state)
		}
	})

	t.Run("prefixed enabled fails closed", func(t *testing.T) {
		xml := strings.Replace(healthyTaskXML(), `<Enabled>true</Enabled><ExecutionTimeLimit>`, `<t:Enabled>false</t:Enabled><ExecutionTimeLimit>`, 1)
		state := ReadWindowsSchedulerXmlState(xml, testWscript, testLauncher)
		if !state.Installed || state.Enabled || state.RegistrationHealthy {
			t.Fatalf("unexpected state: %+v", state)
		}
	})
}
