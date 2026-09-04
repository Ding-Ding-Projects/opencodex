//go:build !windows

package server

func DropWindowsTCPRowsForLocalPort(int) (WindowsTCPDropResult, error) {
	return WindowsTCPDropResult{}, nil
}
