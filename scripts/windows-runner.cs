using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

// Compile as a Windows application: Task Scheduler never creates a console.
internal static class SmashBackgroundRunner
{
    private static int Main(string[] args)
    {
        string root = Directory.GetParent(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)).FullName;
        string log = Path.Combine(root, ".local", "launcher.log");
        try
        {
            if (args.Length != 2 || (args[0] != "host" && args[0] != "update")) return 2;
            if (args[1] != "run" && !(args[0] == "host" &&
                (args[1] == "start" || args[1] == "stop" || args[1] == "restart"))) return 2;
            log = Path.Combine(root, ".local", "launcher-" + args[0] + "-" + args[1] + ".log");
            string script = Path.Combine(root, "scripts", args[0] == "host" ? "windows-service.ps1" : "windows-updater.ps1");
            var info = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\" " + args[1],
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            using (var output = new StreamWriter(log, true))
            using (var process = new Process { StartInfo = info })
            {
                output.AutoFlush = true;
                DataReceivedEventHandler record = (sender, e) => {
                    if (e.Data != null) lock (output) output.WriteLine(DateTime.UtcNow.ToString("o") + " " + e.Data);
                };
                process.OutputDataReceived += record;
                process.ErrorDataReceived += record;
                process.Start();
                process.StandardInput.Close();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            try { File.AppendAllText(log, DateTime.UtcNow.ToString("o") + " " + error.Message + Environment.NewLine); } catch { }
            return 1;
        }
    }
}
