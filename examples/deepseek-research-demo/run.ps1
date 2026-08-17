$ErrorActionPreference = "Stop"

$demoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Push-Location $demoRoot
try {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "trajpack build failed" }
  & node scripts/demo-trajectory.mjs --clean
  if ($LASTEXITCODE -ne 0) { throw "trajpack demo failed" }
  & node --test examples/deepseek-research-demo/demo.test.mjs
  if ($LASTEXITCODE -ne 0) { throw "trajpack demo test failed" }
} finally {
  Pop-Location
}
