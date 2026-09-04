//go:build !darwin

package claude

func defaultKeychainProbe() AuthPresence { return AuthAbsent }
