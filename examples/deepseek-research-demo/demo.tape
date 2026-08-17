# Optional VHS terminal recording recipe. It replays a real local demo run;
# it does not depict model training and is not evidence of model improvement.
Output examples/deepseek-research-demo/trajpack-demo.gif

Set Shell "powershell"
Set FontSize 18
Set Width 1440
Set Height 900
Set TypingSpeed 25ms
Set PlaybackSpeed 1.0

Type "pnpm build"
Enter
Sleep 2s
Type "node scripts/demo-trajectory.mjs --clean"
Enter
Sleep 3s
Type "Get-Content examples/deepseek-research-demo/artifacts/utility-evidence.json"
Enter
Sleep 3s
Type "Get-Content examples/deepseek-research-demo/artifacts/failure/failure-report.json"
Enter
Sleep 3s
