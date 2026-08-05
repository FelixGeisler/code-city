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
    private const int MaximumDecisionSitesPerUnit = 256;
    private const int MaximumDecisionSitesPerFile = 4_096;
    private const int MaximumDecisionSitesPerBatch = 250_000;
    private const int MaximumDecisionEvidenceBytesPerUnit = 96 * 1024;
    private const int MaximumDecisionEvidenceBytesPerFile = 2 * 1024 * 1024;
    private const int MaximumDecisionEvidenceBytesPerBatch = 64 * 1024 * 1024;
    private const string DecisionEvidenceTruncatedReason =
        "Decision-site evidence was truncated by analyzer retention limits.";
    private const string DecisionEvidenceByteLimitWarning =
        "decision-evidence-byte-limit";

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
            var remainingDecisionSites = MaximumDecisionSitesPerBatch;
            var remainingDecisionEvidenceBytes =
                MaximumDecisionEvidenceBytesPerBatch;
            var results = new List<FileResponse>(request.Files.Length);
            foreach (var file in request.Files.OrderBy(item => item.Id, StringComparer.Ordinal))
            {
                var result = Analyze(
                    file,
                    remainingUnits,
                    remainingDecisionSites,
                    remainingDecisionEvidenceBytes
                );
                results.Add(result);
                remainingUnits -= result.Units?.Length ?? 0;
                remainingDecisionSites -= result.Units?.Sum(unit =>
                    unit.DecisionEvidence?.Sites.Length ?? 0
                ) ?? 0;
                remainingDecisionEvidenceBytes -= result.Units?.Sum(unit =>
                    unit.DecisionEvidence is null
                        ? 0
                        : SerializedDecisionEvidenceBytes(unit.DecisionEvidence)
                ) ?? 0;
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

    private static FileResponse Analyze(
        RequestFile file,
        int remainingUnits,
        int remainingDecisionSites,
        int remainingDecisionEvidenceBytes
    )
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

        var sourceDetails = SourceStructure(root, callableNodes);
        var retainedSiteBudget = Math.Min(
            MaximumDecisionSitesPerFile,
            remainingDecisionSites
        );
        var units = new List<UnitMetric>(unitCount);
        var topLevelDecisions = AnalyzeDecisions(root);
        units.Add(new UnitMetric(
            "<top-level>",
            1,
            EndLine(root),
            1 + topLevelDecisions.TotalContribution,
            DecisionEvidence(
                "unit:top-level",
                "top-level",
                null,
                topLevelDecisions,
                ref retainedSiteBudget
            )
        ));
        foreach (var node in callableNodes)
        {
            var callableId = sourceDetails.CallableIds[node];
            var decisions = AnalyzeDecisions(CallableBody(node));
            units.Add(new UnitMetric(
                SanitizeName(UnitName(node)),
                Line(node),
                EndLine(node),
                1 + decisions.TotalContribution,
                DecisionEvidence(
                    $"unit:{callableId}",
                    "callable",
                    callableId,
                    decisions,
                    ref retainedSiteBudget
                )
            ));
        }
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
        orderedUnits = BoundDecisionEvidenceBytes(
            orderedUnits,
            Math.Min(
                MaximumDecisionEvidenceBytesPerFile,
                remainingDecisionEvidenceBytes
            ),
            out var evidenceByteLimitReached
        );
        if (evidenceByteLimitReached)
        {
            warnings = warnings
                .Append(DecisionEvidenceByteLimitWarning)
                .ToArray();
        }
        var decisionLoad = orderedUnits.Sum(unit => unit.Complexity - 1);

        return FileResponse.Success(
            file.Id,
            CountSloc(root),
            decisionLoad,
            orderedUnits.Max(unit => unit.Complexity),
            orderedUnits,
            sourceDetails.Fact,
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

    private static DecisionAnalysis AnalyzeDecisions(SyntaxNode root)
    {
        // An expression-bodied callable can itself return a lambda. Decisions
        // in that nested callable belong only to the lambda's own unit.
        if (IsCallable(root))
        {
            return new DecisionAnalysis(0, Array.Empty<DecisionSiteFact>());
        }
        var totalContribution = 0;
        var sites = new List<DecisionSiteFact>(MaximumDecisionSitesPerUnit);
        var stack = new Stack<SyntaxNode>();
        stack.Push(root);
        while (stack.TryPop(out var node))
        {
            if (!ReferenceEquals(node, root) && IsCallable(node))
            {
                continue;
            }
            var site = DecisionSiteFor(node);
            if (site is not null)
            {
                totalContribution += site.Contribution;
                RetainEarliestDecisionSite(sites, site);
            }
            foreach (var child in node.ChildNodes().Reverse())
            {
                stack.Push(child);
            }
        }
        return new DecisionAnalysis(totalContribution, sites.ToArray());
    }

    private static DecisionSiteFact? DecisionSiteFor(SyntaxNode node) =>
        node switch
        {
            IfStatementSyntax statement => Site("conditional-branch", statement.IfKeyword),
            ForStatementSyntax statement => Site("loop", statement.ForKeyword),
            CommonForEachStatementSyntax statement => Site("loop", statement.ForEachKeyword),
            WhileStatementSyntax statement => Site("loop", statement.WhileKeyword),
            DoStatementSyntax statement => Site("loop", statement.DoKeyword),
            CatchClauseSyntax clause => Site("catch", clause.CatchKeyword),
            ConditionalExpressionSyntax expression => Site(
                "conditional-expression",
                expression.QuestionToken
            ),
            CaseSwitchLabelSyntax label => Site("switch-arm", label.Keyword),
            CasePatternSwitchLabelSyntax label => Site("switch-arm", label.Keyword),
            WhenClauseSyntax clause => Site("guard", clause.WhenKeyword),
            SwitchExpressionArmSyntax arm when arm.Pattern is not DiscardPatternSyntax =>
                Site("switch-arm", arm.EqualsGreaterThanToken),
            BinaryExpressionSyntax binary when binary.IsKind(
                SyntaxKind.LogicalAndExpression
            ) || binary.IsKind(SyntaxKind.LogicalOrExpression) =>
                Site("short-circuit-operator", binary.OperatorToken),
            BinaryExpressionSyntax binary when binary.IsKind(
                SyntaxKind.CoalesceExpression
            ) => Site("nullish-operator", binary.OperatorToken),
            AssignmentExpressionSyntax assignment when assignment.IsKind(
                SyntaxKind.CoalesceAssignmentExpression
            ) => Site("nullish-operator", assignment.OperatorToken),
            BinaryPatternSyntax pattern => Site(
                "pattern-operator",
                pattern.OperatorToken
            ),
            _ => null,
        };

    private static DecisionSiteFact? Site(string kind, SyntaxToken token) =>
        token.IsMissing || token.Span.IsEmpty
            ? null
            : new DecisionSiteFact(kind, Range(token), 1);

    private static int CompareDecisionSites(
        DecisionSiteFact left,
        DecisionSiteFact right
    ) =>
        left.Range.StartLine.CompareTo(right.Range.StartLine) is var line && line != 0
            ? line
            : left.Range.StartColumn.CompareTo(right.Range.StartColumn) is var column && column != 0
                ? column
                : left.Range.EndLine.CompareTo(right.Range.EndLine) is var endLine && endLine != 0
                    ? endLine
                    : left.Range.EndColumn.CompareTo(right.Range.EndColumn) is var endColumn && endColumn != 0
                        ? endColumn
                        : StringComparer.Ordinal.Compare(left.Kind, right.Kind);

    private static void RetainEarliestDecisionSite(
        List<DecisionSiteFact> sites,
        DecisionSiteFact site
    )
    {
        var index = sites.FindIndex(candidate => CompareDecisionSites(candidate, site) > 0);
        if (index < 0)
        {
            if (sites.Count < MaximumDecisionSitesPerUnit) sites.Add(site);
            return;
        }
        if (index >= MaximumDecisionSitesPerUnit) return;
        sites.Insert(index, site);
        if (sites.Count > MaximumDecisionSitesPerUnit)
        {
            sites.RemoveAt(sites.Count - 1);
        }
    }

    private static DecisionEvidenceFact DecisionEvidence(
        string unitId,
        string scope,
        string? callableId,
        DecisionAnalysis analysis,
        ref int retainedSiteBudget
    )
    {
        var retainedCount = Math.Min(analysis.Sites.Length, retainedSiteBudget);
        var retained = analysis.Sites.Take(retainedCount).ToArray();
        retainedSiteBudget -= retainedCount;
        var retainedContribution = retained.Sum(site => site.Contribution);
        var omittedContribution = analysis.TotalContribution - retainedContribution;
        return new DecisionEvidenceFact(
            "codecity.complexity-evidence/1",
            unitId,
            scope,
            callableId,
            omittedContribution == 0 ? "complete" : "truncated",
            analysis.TotalContribution,
            omittedContribution,
            omittedContribution == 0 ? null : DecisionEvidenceTruncatedReason,
            retained
        );
    }

    private static int SerializedDecisionEvidenceBytes(
        DecisionEvidenceFact evidence
    ) => JsonSerializer.SerializeToUtf8Bytes(evidence, JsonOptions).Length;

    private static DecisionEvidenceFact RetainDecisionEvidenceSites(
        DecisionEvidenceFact evidence,
        int retainedSiteCount
    )
    {
        if (retainedSiteCount >= evidence.Sites.Length)
        {
            return evidence;
        }
        if (evidence.TotalContribution is not int totalContribution)
        {
            throw new InvalidDataException();
        }
        var sites = evidence.Sites.Take(retainedSiteCount).ToArray();
        var retainedContribution = sites.Sum(site => site.Contribution);
        return evidence with
        {
            Status = "truncated",
            OmittedContribution = totalContribution - retainedContribution,
            Reason = DecisionEvidenceTruncatedReason,
            Sites = sites,
        };
    }

    private static (DecisionEvidenceFact? Evidence, int Bytes)
        FitDecisionEvidenceBytes(
            DecisionEvidenceFact evidence,
            int serializedByteLimit
        )
    {
        var bytes = SerializedDecisionEvidenceBytes(evidence);
        if (bytes <= serializedByteLimit)
        {
            return (evidence, bytes);
        }

        var lower = 0;
        var upper = evidence.Sites.Length - 1;
        DecisionEvidenceFact? retained = null;
        var retainedBytes = 0;
        while (lower <= upper)
        {
            var middle = (lower + upper) / 2;
            var candidate = RetainDecisionEvidenceSites(evidence, middle);
            bytes = SerializedDecisionEvidenceBytes(candidate);
            if (bytes <= serializedByteLimit)
            {
                retained = candidate;
                retainedBytes = bytes;
                lower = middle + 1;
            }
            else
            {
                upper = middle - 1;
            }
        }
        return (retained, retainedBytes);
    }

    private static UnitMetric[] BoundDecisionEvidenceBytes(
        UnitMetric[] units,
        int serializedByteLimit,
        out bool limitReached
    )
    {
        var remainingBytes = serializedByteLimit;
        limitReached = false;
        var bounded = new UnitMetric[units.Length];
        for (var index = 0; index < units.Length; index++)
        {
            var unit = units[index];
            if (unit.DecisionEvidence is not { } evidence)
            {
                bounded[index] = unit;
                continue;
            }
            var fitted = FitDecisionEvidenceBytes(
                evidence,
                Math.Min(MaximumDecisionEvidenceBytesPerUnit, remainingBytes)
            );
            if (fitted.Evidence is null)
            {
                limitReached = true;
                bounded[index] = unit with { DecisionEvidence = null };
                continue;
            }
            if (!ReferenceEquals(fitted.Evidence, evidence))
            {
                limitReached = true;
            }
            remainingBytes -= fitted.Bytes;
            bounded[index] = unit with { DecisionEvidence = fitted.Evidence };
        }
        return bounded;
    }

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

    private static SourceStructureAnalysis SourceStructure(
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
            "syntax", ParentTypeId(node, typeIds), 1 + AnalyzeDecisions(CallableBody(node)).TotalContribution
        )).OrderBy(item => item.Range.StartLine).ThenBy(item => item.Range.StartColumn)
          .ThenBy(item => item.Kind, StringComparer.Ordinal).ThenBy(item => item.Name, StringComparer.Ordinal)
          .ToArray();
        return new SourceStructureAnalysis(
            new SourceStructureFact(
                "codecity.source-structure/1", "available", types, callables,
                Array.Empty<RelationFact>(),
                new[] { "C# call targets and cross-file type references are unavailable: Roslyn syntax analysis does not load compilation references and does not infer semantic bindings." }
            ),
            callableIds
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

    private static SourceRangeFact Range(SyntaxToken token)
    {
        var span = token.GetLocation().GetLineSpan();
        var tree = token.SyntaxTree ?? throw new InvalidDataException();
        var final = tree.GetLineSpan(
            new Microsoft.CodeAnalysis.Text.TextSpan(token.Span.End - 1, 0)
        ).StartLinePosition;
        return new SourceRangeFact(
            span.StartLinePosition.Line + 1,
            span.StartLinePosition.Character + 1,
            final.Line + 1,
            final.Character + 1
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
    private sealed record UnitMetric(
        string Name,
        int Line,
        int EndLine,
        int Complexity,
        DecisionEvidenceFact? DecisionEvidence
    );
    private sealed record SourceRangeFact(int StartLine, int StartColumn, int EndLine, int EndColumn);
    private sealed record DecisionSiteFact(
        string Kind,
        SourceRangeFact Range,
        int Contribution
    );
    private sealed record DecisionEvidenceFact(
        string Version,
        string UnitId,
        string Scope,
        string? CallableId,
        string Status,
        int? TotalContribution,
        int? OmittedContribution,
        string? Reason,
        DecisionSiteFact[] Sites
    );
    private sealed record DecisionAnalysis(
        int TotalContribution,
        DecisionSiteFact[] Sites
    );
    private sealed record TypeFact(string Id, string Name, string Kind, SourceRangeFact Range, string Provenance, string? ParentTypeId);
    private sealed record CallableFact(string Id, string Name, string Kind, SourceRangeFact Range, string Provenance, string? EnclosingTypeId, int Complexity);
    private sealed record RelationFact(string Id, string Kind, string SourceId, string TargetId, string Provenance);
    private sealed record SourceStructureFact(string Version, string Availability, TypeFact[] Types, CallableFact[] Callables, RelationFact[] Relations, string[] Unavailable);
    private sealed record SourceStructureAnalysis(
        SourceStructureFact Fact,
        IReadOnlyDictionary<SyntaxNode, string> CallableIds
    );

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
