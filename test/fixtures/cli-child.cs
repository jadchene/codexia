using System;
using System.Text;

internal static class CliChild
{
    private static void Line(string value) { Console.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(value))); }
    private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (Array.IndexOf(args, "--quick") >= 0) { Console.Write("quick"); return 0; }
        if (Array.IndexOf(args, "--bulk") >= 0) { Console.Write(new string('x', 256 * 1024)); return 0; }
        if (Array.IndexOf(args, "--line") >= 0) { Console.Write(Console.ReadLine()); return 0; }
        Line(Console.In.ReadToEnd());
        Line(Environment.CurrentDirectory);
        Line(Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") ?? "");
        Line(Environment.GetEnvironmentVariable("CODEXIA_CLI_VERSION") ?? "");
        foreach (string arg in args) Line(arg);
        Console.Error.Write("child stderr");
        return 7;
    }
}
