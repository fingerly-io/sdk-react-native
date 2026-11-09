#
# The CocoaPods spec React Native's autolinking picks up.
#
# The native SDK comes in as a vendored XCFramework, downloaded from Fingerly's
# own host, instead of as `s.dependency 'Fingerly'`. CocoaPods trunk accepts no
# new podspecs after 2026-12-02, so a pod that has to be resolved from trunk
# could never be updated. This package stays a bridge: the implementation is
# the one compiled binary every platform integration ships.
#
# The fetch runs here, while the podspec is evaluated, and not as a
# `prepare_command`. CocoaPods skips the prepare step for a pod it considers
# unchanged, so reinstalling node_modules would remove the framework and leave
# `pod install` with nothing to put it back. The script does nothing once the
# right binary is in place.
#
# spm_dependency is not used. React Native's helper links the Swift package to
# this pod's static library target, and a dynamic binary package linked that
# way is not embedded in the app unless the whole app uses dynamic frameworks.
# CocoaPods embeds a vendored framework in every linkage mode.
#
require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
binary = JSON.parse(File.read(File.join(__dir__, 'ios', 'fingerly-binary.json')))

unless system('bash', File.join(__dir__, 'ios', 'fetch-fingerly-xcframework.sh'),
              binary['version'], binary['sha256'].to_s, __dir__)
  raise "Could not fetch Fingerly.xcframework #{binary['version']}. See the message above."
end

Pod::Spec.new do |s|
  s.name         = 'fingerly-react-native'
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = 'Apache-2.0'
  s.author       = { 'Fingerly' => 'support@fingerly.io' }
  s.homepage     = 'https://fingerly.io'
  # Autolinking installs this pod by path and never reads the source. It names
  # the published tarball so the field still points at something public.
  s.source       = { :http => "https://registry.npmjs.org/@fingerly/react-native/-/react-native-#{s.version}.tgz" }

  # 13.0 matches the native SDK's floor. Raising it here would exclude apps the
  # SDK itself supports, and lowering it would promise a platform the code does
  # not build for.
  s.platforms    = { :ios => '13.0' }
  s.swift_version = '5.9'

  # The framework sits outside ios/ so this glob cannot pick up its headers.
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.vendored_frameworks = 'Frameworks/Fingerly.xcframework'

  s.dependency 'React-Core'
end
