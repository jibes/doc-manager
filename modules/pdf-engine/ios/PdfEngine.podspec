Pod::Spec.new do |s|
  s.name           = 'PdfEngine'
  s.version        = '0.1.0'
  s.summary        = 'Tessel PDF engine (PDFKit)'
  s.license        = 'MIT'
  s.author         = 'Tessel'
  s.homepage       = 'https://github.com/jibes/doc-manager'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'PDFKit'
  s.source_files   = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
end
