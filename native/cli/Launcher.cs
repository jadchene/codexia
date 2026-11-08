using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

// C# 5 / .NET Framework: compiled with Windows' built-in csc.exe, without NuGet or an SDK.
internal static class Launcher
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);

    private static string Installation()
    {
        string entry = Assembly.GetExecutingAssembly().Location;
        using (var file = new FileStream(entry, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        {
            var buffer = new StringBuilder(512);
            uint size = GetFinalPathNameByHandle(file.SafeFileHandle, buffer, (uint)buffer.Capacity, 0);
            if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (size >= buffer.Capacity)
            {
                buffer.Capacity = checked((int)size + 1);
                size = GetFinalPathNameByHandle(file.SafeFileHandle, buffer, (uint)buffer.Capacity, 0);
                if (size == 0 || size >= buffer.Capacity) throw new IOException("Cannot resolve CLI installation.");
            }
            string resolved = buffer.ToString();
            if (resolved.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) resolved = @"\\" + resolved.Substring(8);
            else if (resolved.StartsWith(@"\\?\", StringComparison.Ordinal)) resolved = resolved.Substring(4);
            return Path.GetDirectoryName(resolved);
        }
    }

    // Windows CRT argument quoting: preserve empty strings, quotes and trailing backslashes.
    internal static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static Thread Forward(Stream source, Stream destination, bool closeDestination)
    {
        var thread = new Thread(delegate()
        {
            try
            {
                var buffer = new byte[8192];
                int count;
                bool writable = true;
                while ((count = source.Read(buffer, 0, buffer.Length)) != 0)
                {
                    if (!writable) continue;
                    try { destination.Write(buffer, 0, count); destination.Flush(); }
                    catch (IOException) { if (closeDestination) break; writable = false; }
                }
            }
            catch (IOException) { } // EOF/broken pipe when the child or terminal exits.
            catch (ObjectDisposedException) { }
            finally { if (closeDestination) { try { destination.Close(); } catch (IOException) { } } }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }

    private static void StopChild(Process child)
    {
        try { child.Kill(); }
        catch (InvalidOperationException) { }
        catch (Win32Exception) { }
    }

    private static int Main(string[] args)
    {
        if (args.Length == 1 && (args[0] == "--version" || args[0] == "-v" || args[0] == "version"))
        {
            Console.WriteLine("Codexia " + BuildInfo.Version);
            return 0;
        }
        Encoding inputEncoding = Console.InputEncoding;
        Encoding outputEncoding = Console.OutputEncoding;
        try
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            var arguments = new StringBuilder("--cli");
            if (!Console.IsInputRedirected) arguments.Append(" --cli-interactive");
            foreach (string arg in args) arguments.Append(' ').Append(Quote(arg));
            var start = new ProcessStartInfo(Path.Combine(Installation(), "Codexia.exe"), arguments.ToString());
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
            // Preserve the caller's working directory; resolve only the executable from this installation.
            using (var child = new Process())
            {
                child.StartInfo = start;
                int cancelled = 0;
                ConsoleCancelEventHandler cancel = delegate(object sender, ConsoleCancelEventArgs e)
                {
                    e.Cancel = true;
                    Interlocked.Exchange(ref cancelled, 1);
                    StopChild(child);
                };
                Console.CancelKeyPress += cancel;
                try
                {
                    child.Start();
                    if (Interlocked.CompareExchange(ref cancelled, 0, 0) != 0) StopChild(child);
                    // Raw streams avoid newline conversion, decoder corruption and buffering prompts.
                    Forward(Console.OpenStandardInput(), child.StandardInput.BaseStream, true);
                    Thread stdout = Forward(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
                    Thread stderr = Forward(child.StandardError.BaseStream, Console.OpenStandardError(), false);
                    child.WaitForExit();
                    stdout.Join();
                    stderr.Join();
                    // Never join stdin: an open terminal must not delay --help or error exits.
                    return cancelled != 0 ? 130 : child.ExitCode;
                }
                finally { Console.CancelKeyPress -= cancel; }
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Cannot start same-directory Codexia: " + error.Message);
            return 1;
        }
        finally
        {
            Console.InputEncoding = inputEncoding;
            Console.OutputEncoding = outputEncoding;
        }
    }
}
