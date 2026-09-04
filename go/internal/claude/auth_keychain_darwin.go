//go:build darwin

package claude

func defaultKeychainProbe() AuthPresence { return probeDarwinKeychain(runKeychainCommand) }
