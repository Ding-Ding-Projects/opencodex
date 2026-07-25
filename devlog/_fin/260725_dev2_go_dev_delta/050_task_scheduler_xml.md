# 050_task_scheduler_xml — Windows Task Scheduler XML hardening (#432)

## Objective

Port TS `src/service.ts` XML validation hardening to Go: comment/CDATA stripping,
prefixed tag detection, optional element defaults, Data block rejection, and
`readWindowsSchedulerXmlState`.

## Files

### NEW

| Path | Role |
|---|---|
| `go/internal/service/task_xml.go` | `WindowsTaskRegistrationHealthy`, `ReadWindowsSchedulerXmlState`, XML helper functions |
| `go/internal/service/task_xml_test.go` | Activation tests: decoy rejection, omission defaults, prefixed fail-closed |

### MODIFY

| Path | Before | After |
|---|---|---|
| `go/internal/service/service.go` | `taskManager` stub with only ArtifactPath | Wire `WindowsTaskRegistrationHealthy` into status/health checks if applicable |

### DELETE

None.

## Before/after contracts

1. `taskXMLWithoutCommentsAndCDATA(xml)` strips `<!--...-->` and `<![CDATA[...]]>`
2. `taskXMLElementCount(xml, tag)` counts `<Tag ...>` and `<Tag ... />` with element boundary
3. `taskXMLHasPrefixedTag(xml, tag)` detects `<prefix:Tag>` — fail closed (returns false for health)
4. `taskXMLOptionalValueEquals(xml, tag, expected)` — absent = default true; present must match; prefixed = false; count>1 = false
5. `WindowsTaskRegistrationHealthy(xml, wscript, launcher)`:
   - Scrub comments/CDATA first
   - Reject any `<Data>` element (prefixed or not)
   - Scope `<LogonTrigger>` check to `<Triggers>` section
   - Use `taskXMLOptionalValueEquals` for Enabled, RunLevel (omitted = default)
   - Require LogonType=InteractiveToken, MultipleInstancesPolicy=IgnoreNew, ExecutionTimeLimit=PT0S
   - Require exact Command/Arguments match
6. `ReadWindowsSchedulerXmlState(xml)` → `{Installed, Enabled, RegistrationHealthy}`

## Activation matrix

| ID | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|
| X1 | Healthy registration | Valid XML with all fields | healthy=true | task_xml_test.go |
| X2 | Comment decoy | `<!--<Enabled>true</Enabled>-->` + no real Enabled | healthy=true (omission=default) | task_xml_test.go |
| X3 | CDATA decoy | `<![CDATA[<Enabled>true</Enabled>]]>` | healthy=true (omission=default) | task_xml_test.go |
| X4 | Data block present | `<Data>...</Data>` before real sections | healthy=false | task_xml_test.go |
| X5 | Prefixed Enabled | `<t:Enabled>false</t:Enabled>` | healthy=false (fail closed) | task_xml_test.go |
| X6 | Omitted RunLevel | No RunLevel element | healthy=true (default=LeastPrivilege) | task_xml_test.go |
| X7 | Explicit wrong RunLevel | `<RunLevel>HighestAvailable</RunLevel>` | healthy=false | task_xml_test.go |
| X8 | Self-closing LogonTrigger | `<LogonTrigger />` in Triggers | healthy=true (element present) | task_xml_test.go |
| X9 | LogonTrigger outside Triggers | Decoy outside `<Triggers>` | healthy=false | task_xml_test.go |
| X10 | ReadWindowsSchedulerXmlState | Various XMLs | correct state struct | task_xml_test.go |

## Verification

```bash
cd go
go test ./internal/service -run TestTaskXML -count=1 -v
go build ./... && go vet ./...
```
