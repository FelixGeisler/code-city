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
        var sourceStructure = SourceStructure(root, callableNodes);
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
            sourceStructure,
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

    private static SourceStructureFact SourceStructure(
        CompilationUnitSyntax root,
        SyntaxNode[] callableNodes
    )
    {
        var declarations = root.DescendantNodes()
            .Where(IsTypeDeclaration)
            .OrderBy(node => node.SpanStart)
            .ThenBy(TypeKind, StringComparer.Ordinal)
            .ThenBy(TypeName, StringComparer.Ordinal)
            .ToArray();
        var usedIds = new HashSet<string>(StringComparer.Ordinal);
        var typeIds = declarations.Select(node =>
            new { Node = node, Id = UniqueDetailId("type", node, TypeKind(node), TypeName(node), usedIds) })
            .ToDictionary(item => item.Node, item => item.Id);
        var types = declarations.Select(node => new TypeFact(
            typeIds[node], SanitizeName(TypeName(node)), TypeKind(node), Range(node),
            "syntax", ParentTypeId(node, typeIds)
        )).ToArray();
        var orderedCallables = callableNodes
            .OrderBy(node => node.SpanStart)
            .ThenBy(UnitName, StringComparer.Ordinal)
            .ToArray();
        var callableIds = orderedCallables
            .Select(node => new { Node = node, Id = UniqueDetailId("callable", node, CallableKind(node), UnitName(node), usedIds) })
            .ToDictionary(item => item.Node, item => item.Id);
        var callables = orderedCallables.Select(node => new CallableFact(
            callableIds[node], SanitizeName(UnitName(node)), CallableKind(node), Range(node),
            "syntax", ParentTypeId(node, typeIds), 1 + CountDecisions(CallableBody(node))
        )).OrderBy(item => item.Range.StartLine).ThenBy(item => item.Range.StartColumn)
          .ThenBy(item => item.Kind, StringComparer.Ordinal).ThenBy(item => item.Name, StringComparer.Ordinal)
          .ToArray();
        return new SourceStructureFact(
            "codecity.source-structure/1", "available", types, callables,
            Array.Empty<RelationFact>(),
            new[] { "C# call targets and cross-file type references are unavailable: Roslyn syntax analysis does not load compilation references and does not infer semantic bindings." }
        );
    }

    private static bool IsTypeDeclaration(SyntaxNode node) => node is
        ClassDeclarationSyntax or StructDeclarationSyntax or InterfaceDeclarationSyntax or
        RecordDeclarationSyntax or EnumDeclarationSyntax or DelegateDeclarationSyntax;

    private static string TypeKind(SyntaxNode node) => node switch
    {
        ClassDeclarationSyntax => "class",
        InterfaceDeclarationSyntax => "interface",
        EnumDeclarationSyntax => "enum",
        StructDeclarationSyntax => "struct",
        RecordDeclarationSyntax => "record",
        DelegateDeclarationSyntax => "delegate",
        _ => "type",
    };

    private static string TypeName(SyntaxNode node) => node switch
    {
        BaseTypeDeclarationSyntax declaration => declaration.Identifier.ValueText,
        DelegateDeclarationSyntax declaration => declaration.Identifier.ValueText,
        _ => "<type>",
    };

    private static string CallableKind(SyntaxNode node) => node switch
    {
        ConstructorDeclarationSyntax => "constructor",
        AccessorDeclarationSyntax => "accessor",
        LocalFunctionStatementSyntax => "local-function",
        AnonymousFunctionExpressionSyntax => "lambda",
        _ => "method",
    };

    private static SourceRangeFact Range(SyntaxNode node)
    {
        var span = node.GetLocation().GetLineSpan();
        // Roslyn's span end is exclusive. Resolve the final included UTF-16
        // character so ranges point at source text rather than the next token
        // (or column zero on the following line).
        var final = node.Span.IsEmpty
            ? span.StartLinePosition
            : node.SyntaxTree.GetLineSpan(
                new Microsoft.CodeAnalysis.Text.TextSpan(node.Span.End - 1, 0)
            ).StartLinePosition;
        return new SourceRangeFact(
            span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1,
            final.Line + 1, final.Character + 1
        );
    }

    private static string? ParentTypeId(
        SyntaxNode node,
        IReadOnlyDictionary<SyntaxNode, string> typeIds
    )
    {
        for (var parent = node.Parent; parent is not null; parent = parent.Parent)
        {
            if (typeIds.TryGetValue(parent, out var id)) return id;
        }
        return null;
    }

    private static string UniqueDetailId(
        string prefix, SyntaxNode node, string kind, string name, HashSet<string> used
    )
    {
        var scope = string.Join(".", node.Ancestors()
            .Where(ancestor => ancestor is BaseNamespaceDeclarationSyntax ||
                IsTypeDeclaration(ancestor) || IsCallable(ancestor))
            .Reverse()
            .Select(ScopeIdentity));
        var identity = DeclarationIdentity(node, kind, name);
        var baseId = $"{prefix}:{Fnv64($"{scope.Length}:{scope}|{identity.Length}:{identity}")}";
        var candidate = baseId;
        var collision = 1;
        while (!used.Add(candidate)) candidate = $"{baseId}:{collision++}";
        return candidate;
    }

    private static string ScopeIdentity(SyntaxNode node) => node switch
    {
        BaseNamespaceDeclarationSyntax declaration =>
            $"namespace:{CanonicalTokens(declaration.Name)}",
        _ when IsTypeDeclaration(node) =>
            $"type:{DeclarationIdentity(node, TypeKind(node), TypeName(node))}",
        _ when IsCallable(node) =>
            $"callable:{DeclarationIdentity(node, CallableKind(node), UnitName(node))}",
        _ => node.Kind().ToString(),
    };

    private static string DeclarationIdentity(
        SyntaxNode node, string kind, string name
    )
    {
        var typeParameterCount = node switch
        {
            TypeDeclarationSyntax declaration => declaration.TypeParameterList?.Parameters.Count ?? 0,
            DelegateDeclarationSyntax declaration => declaration.TypeParameterList?.Parameters.Count ?? 0,
            MethodDeclarationSyntax declaration => declaration.TypeParameterList?.Parameters.Count ?? 0,
            LocalFunctionStatementSyntax declaration => declaration.TypeParameterList?.Parameters.Count ?? 0,
            _ => 0,
        };
        var parameters = node switch
        {
            BaseMethodDeclarationSyntax declaration => declaration.ParameterList.Parameters,
            LocalFunctionStatementSyntax declaration => declaration.ParameterList.Parameters,
            ParenthesizedLambdaExpressionSyntax declaration => declaration.ParameterList.Parameters,
            SimpleLambdaExpressionSyntax declaration =>
                SyntaxFactory.SingletonSeparatedList(declaration.Parameter),
            AnonymousMethodExpressionSyntax declaration => declaration.ParameterList?.Parameters ?? default,
            DelegateDeclarationSyntax declaration => declaration.ParameterList.Parameters,
            _ => default,
        };
        var signature = string.Join(",", parameters.Select(parameter =>
            $"{(parameter.Modifiers.Count == 0 ? "value" : string.Join("+", parameter.Modifiers.Select(modifier => modifier.ValueText)))}:" +
            $"{(parameter.Default is null ? "required" : "optional")}:" +
            CanonicalTokens(parameter.Type)));
        return $"{kind}:{SanitizeName(name)}:type-parameters:{typeParameterCount}:parameters:{signature}";
    }

    private static string CanonicalTokens(SyntaxNode? node) => node is null
        ? "unknown"
        : string.Join(" ", node.DescendantTokens(descendIntoTrivia: false)
            .Where(token => !token.IsMissing)
            .Select(token => token.ValueText.Normalize(NormalizationForm.FormC)));

    private static string Fnv64(string value)
    {
        const ulong offset = 14695981039346656037UL;
        const ulong prime = 1099511628211UL;
        var hash = offset;
        foreach (var valueByte in Encoding.UTF8.GetBytes(value))
        {
            hash ^= valueByte;
            hash *= prime;
        }
        return hash.ToString("x16", CultureInfo.InvariantCulture);
    }

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
    private sealed record SourceRangeFact(int StartLine, int StartColumn, int EndLine, int EndColumn);
    private sealed record TypeFact(string Id, string Name, string Kind, SourceRangeFact Range, string Provenance, string? ParentTypeId);
    private sealed record CallableFact(string Id, string Name, string Kind, SourceRangeFact Range, string Provenance, string? EnclosingTypeId, int Complexity);
    private sealed record RelationFact(string Id, string Kind, string SourceId, string TargetId, string Provenance);
    private sealed record SourceStructureFact(string Version, string Availability, TypeFact[] Types, CallableFact[] Callables, RelationFact[] Relations, string[] Unavailable);

    private sealed record FileResponse(
        string Id,
        string Status,
        string? MetricMethod,
        int? Sloc,
        int? DecisionLoad,
        int? MaximumComplexity,
        int? ExecutableUnitCount,
        UnitMetric[]? Units,
        SourceStructureFact? SourceStructure,
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
            SourceStructureFact sourceStructure,
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
            sourceStructure,
            warnings,
            null
        );

        internal static FileResponse Skipped(string id, string warning) =>
            new(id, "skipped", null, null, null, null, null, null, null, null, warning);
    }
}
