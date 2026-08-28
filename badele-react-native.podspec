#
# The CocoaPods spec React Native's autolinking picks up.
#
# It depends on the native SDK rather than vendoring a copy of it. That is the
# whole architecture in one line: `mobile/ios` is the implementation, and this
# package is a bridge to it, so a fix to a jailbreak check reaches React Native
# apps by bumping one dependency rather than by porting the fix a second time.
#
require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'badele-react-native'
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = 'Apache-2.0'
  s.author       = { 'Badele' => 'support@badele.io' }
  s.homepage     = 'https://badele.io'
  s.source       = { :git => 'https://github.com/badele-io/sdk-react-native.git', :tag => s.version.to_s }

  # 13.0 matches the native SDK's floor. Raising it here would exclude apps the
  # SDK itself supports, and lowering it would promise a platform the code does
  # not build for.
  s.platforms    = { :ios => '13.0' }
  s.swift_version = '5.9'

  s.source_files = 'ios/**/*.{h,m,mm,swift}'

  s.dependency 'React-Core'
  # The SDK. Everything this package does is call into it.
  s.dependency 'Badele'
end
