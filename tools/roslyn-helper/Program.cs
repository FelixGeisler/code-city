using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeCity.RoslynHelper;

internal static class Program
{
    internal const string ProtocolVersion = "code-city.roslyn/1";
    private const int MaximumFiles = 25_000;
    private const int MaximumPathCharacters = 2_048;
    private const int MaximumSourceBytes = 2 * 1024 * 1024;
    private const int MaximumRequestBytes = 256 * 1024 * 1024;
    private const int MaximumResponseBytes = 64 * 1024 * 1024;
    private const int MaximumUnitsPerFile = 10_000;
    private const int MaximumUnitsPerBatch = 250_000;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 16,
    };

    public static async Task<int> Main()
    {
        try
        {
            var requestBytes = await ReadBoundedAsync(
                Console.OpenStandardInput(),
                MaximumRequestBytes
            );
            var request = JsonSerializer.Deserialize<AnalysisRequest>(
                requestBytes,
                JsonOptions
            ) ?? throw new InvalidDataException();
            ValidateRequest(request);

            var remainingUnits = MaximumUnitsPerBatch;
            var results = new List<FileResponse>(request.Files.Length);
            foreach (var file in request.Files.OrderBy(item => item.Id, StringComparer.Ordinal))
            {
                var result = Analyze(file, remainingUnits);
                results.Add(result);
                remainingUnits -= result.Units?.Length ?? 0;
            }

            var response = new AnalysisResponse(ProtocolVersion, results.ToArray());
            var responseBytes = JsonSerializer.SerializeToUtf8Bytes(response, JsonOptions);
            if (responseBytes.Length > MaximumResponseBytes)
            {
                throw new InvalidDataException();
            }
            await Console.OpenStandardOutput().WriteAsync(responseBytes);
            return 0;
        }
        catch
        {
            // Never echo source, paths, parser messages, or exception details.
            var failure = Encoding.UTF8.GetBytes(
                """{"protocolVersion":"code-city.roslyn/1","error":"invalid-request"}"""
            );
            await Console.OpenStandardOutput().WriteAsync(failure);
            return 2;
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(Stream input, int maximumBytes)
    {
        using var output = new MemoryStream();
        var buffer = new byte[64 * 1024];
        while (true)
        {
            var remaining = maximumBytes - checked((int)output.Length);
            var requested = Math.Min(buffer.Length, remaining + 1);
            var read = await input.ReadAsync(buffer.AsMemory(0, requested));
            if (read == 0)
            {
                return output.ToArray();
            }
            if (output.Length + read > maximumBytes)
            {
                throw new InvalidDataException();
            }
            await output.WriteAsync(buffer.AsMemory(0, read));
        }
    }

    private static void ValidateRequest(AnalysisRequest request)
    {
        if (request.ProtocolVersion != ProtocolVersion ||
            request.Files is null ||
            request.Files.Length > MaximumFiles)
        {
            throw new InvalidDataException();
        }

        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in request.Files)
        {
            if (file is null ||
                !IsOpaqueId(file.Id) ||
                file.Id.Length > MaximumPathCharacters ||
                !ids.Add(file.Id) ||
                Encoding.UTF8.GetByteCount(file.Source) > MaximumSourceBytes)
            {
                throw new InvalidDataException();
            }
        }
    }

    private static bool IsOpaqueId(string id)
    {
        if (string.IsNullOrEmpty(id) ||
            !id.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) ||
            !char.IsAsciiLetterOrDigit(id[0]))
        {
            return false;
        }
        return id.All(character =>
            char.IsAsciiLetterOrDigit(character) ||
            character is '.' or '_' or '-'
        );
    }

    private static FileResponse Analyze(RequestFile file, int remainingUnits)
    {
        var tree = CSharpSyntaxTree.ParseText(
            file.Source,
            new CSharpParseOptions(
                LanguageVersion.Latest,
                DocumentationMode.Parse,
                SourceCodeKind.Regular
            ),
            path: file.Id,
            encoding: Encoding.UTF8
        );
        var root = tree.GetCompilationUnitRoot();
        var callableNodes = root
            .DescendantNodes()
            .Where(IsCallable)
            .OrderBy(Line)
            .ThenBy(UnitName, StringComparer.Ordinal)
            .ToArray();
        var unitCount = callableNodes.Length + 1;
        if (unitCount > MaximumUnitsPerFile)
        {
            return FileResponse.Skipped(file.Id, "unit-limit");
        }
        if (unitCount > remainingUnits)
        {
            return FileResponse.Skipped(file.Id, "batch-unit-limit");
        }

        var units = new List<UnitMetric>(unitCount)
        {
            new("<top-level>", 1, EndLine(root), 1 + CountDecisions(root)),
        };
        units.AddRange(callableNodes.Select(node =>
                new UnitMetric(
                    SanitizeName(UnitName(node)),
                    Line(node),
                    EndLine(node),
                    1 + CountDecisions(CallableBody(node))
                )
        ));
        var orderedUnits = units
            .OrderBy(unit => unit.Line)
            .ThenBy(unit => unit.Name, StringComparer.Ordinal)
            .ThenBy(unit => unit.Complexity)
            .ToArray();
        var warnings = tree
            .GetDiagnostics()
            .Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error)
                ? new[] { "syntax-errors-present" }
                : Array.Empty<string>();
        var decisionLoad = orderedUnits.Sum(unit => unit.Complexity - 1);

        return FileResponse.Success(
            file.Id,
            CountSloc(root),
            decisionLoad,
            orderedUnits.Max(unit => unit.Complexity),
            orderedUnits,
            warnings
        );
    }

    private static int CountSloc(CompilationUnitSyntax root)
    {
        var lines = new HashSet<int>();
        foreach (var token in root.DescendantTokens(descendIntoTrivia: false))
        {
            if (token.IsMissing || token.IsKind(SyntaxKind.EndOfFileToken) ||
                token.Span.IsEmpty)
            {
                continue;
            }
            var span = token.GetLocation().GetLineSpan();
            for (var line = span.StartLinePosition.Line; line <= span.EndLinePosition.Line; line++)
            {
                lines.Add(line);
            }
        }
        return lines.Count;
    }

    private static int CountDecisions(SyntaxNode root)
    {
        // An expression-bodied callable can itself return a lambda. Decisions
        // in that nested callable belong only to the lambda's own unit.
        if (IsCallable(root))
        {
            return 0;
        }
        var decisions = 0;
        var stack = new Stack<SyntaxNode>();
        stack.Push(root);
        while (stack.TryPop(out var node))
        {
            if (!ReferenceEquals(node, root) && IsCallable(node))
            {
                continue;
            }
            decisions += DecisionIncrement(node);
            foreach (var child in node.ChildNodes().Reverse())
            {
                stack.Push(child);
            }
        }
        return decisions;
    }

    private static int DecisionIncrement(SyntaxNode node) =>
        node switch
        {
            IfStatementSyntax => 1,
            ForStatementSyntax => 1,
            CommonForEachStatementSyntax => 1,
            WhileStatementSyntax => 1,
            DoStatementSyntax => 1,
            CatchClauseSyntax => 1,
            ConditionalExpressionSyntax => 1,
            CaseSwitchLabelSyntax => 1,
            CasePatternSwitchLabelSyntax => 1,
            WhenClauseSyntax => 1,
            SwitchExpressionArmSyntax arm when arm.Pattern is not DiscardPatternSyntax => 1,
            BinaryExpressionSyntax binary when binary.IsKind(
                SyntaxKind.LogicalAndExpression
            ) || binary.IsKind(SyntaxKind.LogicalOrExpression) ||
                 binary.IsKind(SyntaxKind.CoalesceExpression) => 1,
            AssignmentExpressionSyntax assignment when assignment.IsKind(
                SyntaxKind.CoalesceAssignmentExpression
            ) => 1,
            BinaryPatternSyntax => 1,
            _ => 0,
        };

    private static bool IsCallable(SyntaxNode node) =>
        node is BaseMethodDeclarationSyntax or
            AccessorDeclarationSyntax or
            LocalFunctionStatementSyntax or
            AnonymousFunctionExpressionSyntax;

    private static SyntaxNode CallableBody(SyntaxNode node) =>
        node switch
        {
            BaseMethodDeclarationSyntax method =>
                method.Body ?? (SyntaxNode?)method.ExpressionBody?.Expression ?? method,
            AccessorDeclarationSyntax accessor =>
                accessor.Body ?? (SyntaxNode?)accessor.ExpressionBody?.Expression ?? accessor,
            LocalFunctionStatementSyntax local =>
                local.Body ?? (SyntaxNode?)local.ExpressionBody?.Expression ?? local,
            AnonymousFunctionExpressionSyntax anonymous => anonymous.Body,
            _ => node,
        };

    private static int Line(SyntaxNode node) =>
        node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    private static int EndLine(SyntaxNode node) =>
        node.GetLocation().GetLineSpan().EndLinePosition.Line + 1;

    private static string UnitName(SyntaxNode node) =>
        node switch
        {
            MethodDeclarationSyntax method => method.Identifier.ValueText,
            ConstructorDeclarationSyntax constructor => constructor.Identifier.ValueText,
            DestructorDeclarationSyntax destructor => $"~{destructor.Identifier.ValueText}",
            OperatorDeclarationSyntax operation => $"operator {operation.OperatorToken.ValueText}",
            ConversionOperatorDeclarationSyntax conversion =>
                $"{conversion.ImplicitOrExplicitKeyword.ValueText} operator",
            AccessorDeclarationSyntax accessor => AccessorName(accessor),
            LocalFunctionStatementSyntax local => local.Identifier.ValueText,
            ParenthesizedLambdaExpressionSyntax or SimpleLambdaExpressionSyntax => "<lambda>",
            AnonymousMethodExpressionSyntax => "<anonymous>",
            _ => "<callable>",
        };

    private static string AccessorName(AccessorDeclarationSyntax accessor)
    {
        var owner = accessor.Parent?.Parent switch
        {
            PropertyDeclarationSyntax property => property.Identifier.ValueText,
            IndexerDeclarationSyntax => "this",
            EventDeclarationSyntax eventDeclaration => eventDeclaration.Identifier.ValueText,
            _ => "",
        };
        return owner.Length == 0
            ? accessor.Keyword.ValueText
            : $"{owner}.{accessor.Keyword.ValueText}";
    }

    private static string SanitizeName(string original)
    {
        var normalized = original.Normalize(NormalizationForm.FormC);
        var output = new StringBuilder();
        var whitespace = false;
        foreach (var rune in normalized.EnumerateRunes())
        {
            var category = Rune.GetUnicodeCategory(rune);
            if (category is UnicodeCategory.Control or UnicodeCategory.Format or
                UnicodeCategory.Surrogate)
            {
                continue;
            }
            if (Rune.IsWhiteSpace(rune))
            {
                whitespace = output.Length > 0;
                continue;
            }
            if (whitespace && output.Length < 256)
            {
                output.Append(' ');
            }
            whitespace = false;
            if (output.Length + rune.Utf16SequenceLength > 256)
            {
                break;
            }
            output.Append(rune);
        }
        return output.ToString().Trim() is { Length: > 0 } value
            ? value
            : "<callable>";
    }

    private sealed record AnalysisRequest(string ProtocolVersion, RequestFile[] Files);
    private sealed record RequestFile(string Id, string Source);
    private sealed record AnalysisResponse(string ProtocolVersion, FileResponse[] Files);
    private sealed record UnitMetric(string Name, int Line, int EndLine, int Complexity);

    private sealed record FileResponse(
        string Id,
        string Status,
        string? MetricMethod,
        int? Sloc,
        int? DecisionLoad,
        int? MaximumComplexity,
        int? ExecutableUnitCount,
        UnitMetric[]? Units,
        string[]? Warnings,
        string? Warning
    )
    {
        internal static FileResponse Success(
            string id,
            int sloc,
            int decisionLoad,
            int maximumComplexity,
            UnitMetric[] units,
            string[] warnings
        ) => new(
            id,
            "ok",
            "csharp-roslyn-v1",
            sloc,
            decisionLoad,
            maximumComplexity,
            units.Length,
            units,
            warnings,
            null
        );

        internal static FileResponse Skipped(string id, string warning) =>
            new(id, "skipped", null, null, null, null, null, null, null, warning);
    }
}
