using System.Buffers;
using System.Buffers.Binary;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace CodeCity.GitCredentialHelper;

internal static class Program
{
    private static ReadOnlySpan<byte> BrokerInitializationMagic => "CCGITB1\n"u8;
    private static ReadOnlySpan<byte> HelperRequestMagic => "CCGITH1\n"u8;
    private static ReadOnlySpan<byte> BrokerResponseMagic => "CCGITR1\n"u8;
    private static ReadOnlySpan<byte> HelperAcknowledgementMagic => "CCGITA1\n"u8;
    private static ReadOnlySpan<byte> HttpsValue => "https"u8;
    private static ReadOnlySpan<byte> RejectPayload => "quit=1\n\n"u8;

    private const int MaximumHostBytes = 512;
    private const int MaximumPathBytes = 4096;
    private const int MaximumUsernameBytes = 256;
    private const int MaximumSecretBytes = 8192;
    private const int MaximumCredentialPayloadBytes = 16 * 1024;
    private const int MaximumConnections = 8;
    private const int MaximumGets = 2;
    private const int HelperTimeoutMilliseconds = 5000;
    private const string PipePrefix = "codecity-git-";

    private enum HelperAction : byte
    {
        Get = 1,
        Store = 2,
        Erase = 3,
    }

    private enum BrokerStatus : byte
    {
        Empty = 0,
        Credential = 1,
        Reject = 2,
    }

    private readonly record struct BoundedInput(byte[] Buffer, int Length);
    private readonly record struct BrokerConnectionResult(
        bool Terminate,
        bool WasGet);

    public static async Task<int> Main(string[] arguments)
    {
        try
        {
            if (arguments.Length == 1 &&
                string.Equals(arguments[0], "broker", StringComparison.Ordinal))
            {
                return await RunBrokerAsync().ConfigureAwait(false);
            }

            if (arguments.Length == 3 &&
                string.Equals(arguments[0], "helper", StringComparison.Ordinal) &&
                ValidPipeName(arguments[1]) &&
                TryParseAction(arguments[2], out HelperAction action))
            {
                return await RunHelperAsync(arguments[1], action).ConfigureAwait(false);
            }
        }
        catch
        {
            // The parent receives only a fixed nonzero exit status.
        }

        return 1;
    }

    private static bool TryParseAction(string value, out HelperAction action)
    {
        action = value switch
        {
            "get" => HelperAction.Get,
            "store" => HelperAction.Store,
            "erase" => HelperAction.Erase,
            _ => 0,
        };
        return action != 0;
    }

    private static bool ValidPipeName(string? value)
    {
        if (value is null ||
            value.Length != PipePrefix.Length + 64 ||
            !value.StartsWith(PipePrefix, StringComparison.Ordinal))
        {
            return false;
        }

        foreach (char character in value.AsSpan(PipePrefix.Length))
        {
            if (!((character >= '0' && character <= '9') ||
                  (character >= 'a' && character <= 'f')))
            {
                return false;
            }
        }

        return true;
    }

    private static string CreatePipeName()
    {
        byte[] random = RandomNumberGenerator.GetBytes(32);
        try
        {
            return PipePrefix + Convert.ToHexString(random).ToLowerInvariant();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(random);
        }
    }

    private static async Task<int> RunBrokerAsync()
    {
        Stream input = Console.OpenStandardInput();
        Stream output = Console.OpenStandardOutput();
        byte[]? expectedHost = null;
        byte[]? expectedPath = null;
        byte[]? username = null;
        byte[]? secret = null;
        CancellationTokenSource? lifetime = null;
        Task? parentMonitor = null;

        try
        {
            using var initializationTimeout =
                new CancellationTokenSource(HelperTimeoutMilliseconds);
            CancellationToken initializationToken = initializationTimeout.Token;

            byte[] magic = new byte[BrokerInitializationMagic.Length];
            try
            {
                await ReadExactlyAsync(input, magic, initializationToken)
                    .ConfigureAwait(false);
                if (!magic.AsSpan().SequenceEqual(BrokerInitializationMagic))
                {
                    return 1;
                }
            }
            finally
            {
                CryptographicOperations.ZeroMemory(magic);
            }

            uint timeoutValue = await ReadUInt32Async(input, initializationToken)
                .ConfigureAwait(false);
            if (timeoutValue == 0 || timeoutValue > int.MaxValue)
            {
                return 1;
            }

            expectedHost = await ReadLengthPrefixedAsync(
                    input,
                    MaximumHostBytes,
                    initializationToken)
                .ConfigureAwait(false);
            expectedPath = await ReadLengthPrefixedAsync(
                    input,
                    MaximumPathBytes,
                    initializationToken)
                .ConfigureAwait(false);
            username = await ReadLengthPrefixedAsync(
                    input,
                    MaximumUsernameBytes,
                    initializationToken)
                .ConfigureAwait(false);
            secret = await ReadLengthPrefixedAsync(
                    input,
                    MaximumSecretBytes,
                    initializationToken)
                .ConfigureAwait(false);

            if (expectedHost.Length == 0 ||
                !IsHostAscii(expectedHost) ||
                expectedPath.Length == 0 ||
                !IsSafeUtf8Line(expectedPath, requireNonempty: true) ||
                username.Length == 0 ||
                !IsUsernameAscii(username) ||
                !IsSafeUtf8Line(secret, requireNonempty: true))
            {
                return 1;
            }

            lifetime = new CancellationTokenSource();
            lifetime.CancelAfter(TimeSpan.FromMilliseconds(timeoutValue));
            parentMonitor = MonitorParentLifetimeAsync(input, lifetime);

            string pipeName = CreatePipeName();
            using var pipe = new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly,
                MaximumCredentialPayloadBytes,
                MaximumCredentialPayloadBytes);

            byte[] readiness = Encoding.ASCII.GetBytes(
                $"{BrokerInitializationMagicAsText()} {pipeName}\n");
            try
            {
                await output.WriteAsync(readiness, lifetime.Token)
                    .ConfigureAwait(false);
                await output.FlushAsync(lifetime.Token).ConfigureAwait(false);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(readiness);
            }

            int getCount = 0;
            for (int connectionCount = 0;
                 connectionCount < MaximumConnections;
                 connectionCount++)
            {
                try
                {
                    await pipe.WaitForConnectionAsync(lifetime.Token)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
                {
                    return 0;
                }

                BrokerConnectionResult result;
                try
                {
                    result = await HandleBrokerConnectionAsync(
                            pipe,
                            expectedHost,
                            expectedPath,
                            username,
                            secret,
                            getCount,
                            lifetime.Token)
                        .ConfigureAwait(false);
                }
                finally
                {
                    if (pipe.IsConnected)
                    {
                        pipe.Disconnect();
                    }
                }

                if (result.Terminate)
                {
                    return 0;
                }

                if (result.WasGet)
                {
                    getCount++;
                }
            }

            return 0;
        }
        catch (OperationCanceledException) when (lifetime?.IsCancellationRequested == true)
        {
            return 0;
        }
        catch
        {
            return 1;
        }
        finally
        {
            lifetime?.Cancel();
            if (parentMonitor is not null)
            {
                await ObserveMonitorAsync(parentMonitor).ConfigureAwait(false);
            }

            Zero(expectedHost);
            Zero(expectedPath);
            Zero(username);
            Zero(secret);
            lifetime?.Dispose();
        }
    }

    private static async Task<BrokerConnectionResult>
        HandleBrokerConnectionAsync(
        Stream pipe,
        byte[] expectedHost,
        byte[] expectedPath,
        byte[] username,
        byte[] secret,
        int previousGetCount,
        CancellationToken cancellationToken)
    {
        byte[]? payload = null;
        byte[]? credentialResponse = null;
        bool responseStarted = false;

        try
        {
            byte[] header = new byte[HelperRequestMagic.Length + 1 + sizeof(uint)];
            try
            {
                await ReadExactlyAsync(pipe, header, cancellationToken)
                    .ConfigureAwait(false);
                if (!header.AsSpan(0, HelperRequestMagic.Length)
                    .SequenceEqual(HelperRequestMagic))
                {
                    responseStarted = true;
                    await WriteBrokerResponseAsync(
                            pipe,
                            BrokerStatus.Reject,
                            ReadOnlyMemory<byte>.Empty,
                            cancellationToken)
                        .ConfigureAwait(false);
                    return new BrokerConnectionResult(true, false);
                }

                HelperAction action = (HelperAction)header[HelperRequestMagic.Length];
                uint payloadLength = BinaryPrimitives.ReadUInt32BigEndian(
                    header.AsSpan(HelperRequestMagic.Length + 1, sizeof(uint)));
                if ((action != HelperAction.Get &&
                     action != HelperAction.Store &&
                     action != HelperAction.Erase) ||
                    payloadLength > MaximumCredentialPayloadBytes)
                {
                    responseStarted = true;
                    await WriteBrokerResponseAsync(
                            pipe,
                            BrokerStatus.Reject,
                            ReadOnlyMemory<byte>.Empty,
                            cancellationToken)
                        .ConfigureAwait(false);
                    return new BrokerConnectionResult(true, false);
                }

                payload = new byte[(int)payloadLength];
                await ReadExactlyAsync(pipe, payload, cancellationToken)
                    .ConfigureAwait(false);

                if (action == HelperAction.Store || action == HelperAction.Erase)
                {
                    responseStarted = true;
                    await WriteBrokerResponseAsync(
                            pipe,
                            BrokerStatus.Empty,
                            ReadOnlyMemory<byte>.Empty,
                            cancellationToken)
                        .ConfigureAwait(false);
                    return new BrokerConnectionResult(false, false);
                }

                if (previousGetCount >= MaximumGets ||
                    !ValidGetQuery(payload, expectedHost, expectedPath, username))
                {
                    responseStarted = true;
                    await WriteBrokerResponseAsync(
                            pipe,
                            BrokerStatus.Reject,
                            ReadOnlyMemory<byte>.Empty,
                            cancellationToken)
                        .ConfigureAwait(false);
                    return new BrokerConnectionResult(true, true);
                }

                credentialResponse = CreateCredentialResponse(username, secret);
                responseStarted = true;
                await WriteBrokerResponseAsync(
                        pipe,
                        BrokerStatus.Credential,
                        credentialResponse,
                        cancellationToken)
                    .ConfigureAwait(false);
                return new BrokerConnectionResult(false, true);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(header);
            }
        }
        catch
        {
            if (!responseStarted)
            {
                try
                {
                    responseStarted = true;
                    await WriteBrokerResponseAsync(
                            pipe,
                            BrokerStatus.Reject,
                            ReadOnlyMemory<byte>.Empty,
                            cancellationToken)
                        .ConfigureAwait(false);
                }
                catch
                {
                    // The fixed broker exit status communicates the failure.
                }
            }

            return new BrokerConnectionResult(true, false);
        }
        finally
        {
            Zero(payload);
            Zero(credentialResponse);
        }
    }

    private static byte[] CreateCredentialResponse(
        ReadOnlySpan<byte> username,
        ReadOnlySpan<byte> secret)
    {
        ReadOnlySpan<byte> usernamePrefix = "username="u8;
        ReadOnlySpan<byte> passwordPrefix = "\npassword="u8;
        ReadOnlySpan<byte> terminator = "\n\n"u8;
        int length = checked(
            usernamePrefix.Length +
            username.Length +
            passwordPrefix.Length +
            secret.Length +
            terminator.Length);
        byte[] response = new byte[length];
        Span<byte> destination = response;
        int offset = 0;
        usernamePrefix.CopyTo(destination[offset..]);
        offset += usernamePrefix.Length;
        username.CopyTo(destination[offset..]);
        offset += username.Length;
        passwordPrefix.CopyTo(destination[offset..]);
        offset += passwordPrefix.Length;
        secret.CopyTo(destination[offset..]);
        offset += secret.Length;
        terminator.CopyTo(destination[offset..]);
        return response;
    }

    private static bool ValidGetQuery(
        ReadOnlySpan<byte> payload,
        ReadOnlySpan<byte> expectedHost,
        ReadOnlySpan<byte> expectedPath,
        ReadOnlySpan<byte> expectedUsername)
    {
        if (payload.IsEmpty ||
            payload[^1] != (byte)'\n' ||
            payload.Contains((byte)0))
        {
            return false;
        }

        bool sawProtocol = false;
        bool sawHost = false;
        bool sawPath = false;
        bool sawUsername = false;
        // Git may terminate the attribute list either with EOF immediately
        // after the final LF or with one blank line before EOF.
        ReadOnlySpan<byte> fields =
            payload.Length >= 2 && payload[^2] == (byte)'\n'
                ? payload[..^1]
                : payload;

        while (!fields.IsEmpty)
        {
            int newline = fields.IndexOf((byte)'\n');
            if (newline <= 0)
            {
                return false;
            }

            ReadOnlySpan<byte> line = fields[..newline];
            fields = fields[(newline + 1)..];
            int equals = line.IndexOf((byte)'=');
            if (equals <= 0)
            {
                return false;
            }

            ReadOnlySpan<byte> key = line[..equals];
            ReadOnlySpan<byte> value = line[(equals + 1)..];
            if (key.SequenceEqual("protocol"u8))
            {
                if (sawProtocol || !value.SequenceEqual(HttpsValue))
                {
                    return false;
                }

                sawProtocol = true;
            }
            else if (key.SequenceEqual("host"u8))
            {
                if (sawHost || !AsciiEqualsIgnoreCase(value, expectedHost))
                {
                    return false;
                }

                sawHost = true;
            }
            else if (key.SequenceEqual("path"u8))
            {
                if (sawPath || !value.SequenceEqual(expectedPath))
                {
                    return false;
                }

                sawPath = true;
            }
            else if (key.SequenceEqual("username"u8))
            {
                if (sawUsername || !value.SequenceEqual(expectedUsername))
                {
                    return false;
                }

                sawUsername = true;
            }
            else
            {
                // Git forwards advisory attributes such as repeated
                // wwwauth[] and capability[] fields, and its credential
                // protocol requires helpers to ignore attributes they do not
                // understand. Only the scalar fields above participate in
                // the exact credential scope; the complete request is
                // already bounded by MaximumCredentialPayloadBytes.
            }
        }

        return sawProtocol && sawHost && sawPath;
    }

    private static bool AsciiEqualsIgnoreCase(
        ReadOnlySpan<byte> left,
        ReadOnlySpan<byte> right)
    {
        if (left.Length != right.Length)
        {
            return false;
        }

        for (int index = 0; index < left.Length; index++)
        {
            byte leftValue = left[index];
            byte rightValue = right[index];
            if (leftValue > 0x7f || rightValue > 0x7f)
            {
                return false;
            }

            if (leftValue >= (byte)'A' && leftValue <= (byte)'Z')
            {
                leftValue = (byte)(leftValue + 0x20);
            }

            if (rightValue >= (byte)'A' && rightValue <= (byte)'Z')
            {
                rightValue = (byte)(rightValue + 0x20);
            }

            if (leftValue != rightValue)
            {
                return false;
            }
        }

        return true;
    }

    private static async Task<int> RunHelperAsync(
        string pipeName,
        HelperAction action)
    {
        BoundedInput input = default;
        byte[]? responsePayload = null;

        try
        {
            using var timeout = new CancellationTokenSource(
                HelperTimeoutMilliseconds);
            CancellationToken cancellationToken = timeout.Token;
            input = await ReadBoundedToEndAsync(
                    Console.OpenStandardInput(),
                    MaximumCredentialPayloadBytes,
                    cancellationToken)
                .ConfigureAwait(false);

            using var pipe = new NamedPipeClientStream(
                ".",
                pipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.ConnectAsync(
                    HelperTimeoutMilliseconds,
                    cancellationToken)
                .ConfigureAwait(false);

            await WriteHelperRequestAsync(
                    pipe,
                    action,
                    input.Buffer.AsMemory(0, input.Length),
                    cancellationToken)
                .ConfigureAwait(false);
            (BrokerStatus status, responsePayload) =
                await ReadBrokerResponseAsync(pipe, cancellationToken)
                    .ConfigureAwait(false);
            await WriteHelperAcknowledgementAsync(pipe, cancellationToken)
                .ConfigureAwait(false);

            if (action != HelperAction.Get)
            {
                return status == BrokerStatus.Empty &&
                       responsePayload.Length == 0
                    ? 0
                    : 1;
            }

            Stream output = Console.OpenStandardOutput();
            if (status == BrokerStatus.Credential)
            {
                if (responsePayload.Length == 0)
                {
                    return 1;
                }

                await output.WriteAsync(responsePayload, cancellationToken)
                    .ConfigureAwait(false);
                await output.FlushAsync(cancellationToken).ConfigureAwait(false);
                return 0;
            }

            if (status == BrokerStatus.Reject &&
                responsePayload.Length == 0)
            {
                await output.WriteAsync(RejectPayload.ToArray(), cancellationToken)
                    .ConfigureAwait(false);
                await output.FlushAsync(cancellationToken).ConfigureAwait(false);
                return 0;
            }

            return status == BrokerStatus.Empty &&
                   responsePayload.Length == 0
                ? 0
                : 1;
        }
        catch
        {
            return 1;
        }
        finally
        {
            Zero(input.Buffer);
            Zero(responsePayload);
        }
    }

    private static async Task WriteHelperRequestAsync(
        Stream pipe,
        HelperAction action,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken)
    {
        byte[] header = new byte[HelperRequestMagic.Length + 1 + sizeof(uint)];
        try
        {
            HelperRequestMagic.CopyTo(header);
            header[HelperRequestMagic.Length] = (byte)action;
            BinaryPrimitives.WriteUInt32BigEndian(
                header.AsSpan(HelperRequestMagic.Length + 1, sizeof(uint)),
                checked((uint)payload.Length));
            await pipe.WriteAsync(header, cancellationToken).ConfigureAwait(false);
            if (!payload.IsEmpty)
            {
                await pipe.WriteAsync(payload, cancellationToken)
                    .ConfigureAwait(false);
            }

            await pipe.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(header);
        }
    }

    private static async Task<(BrokerStatus Status, byte[] Payload)>
        ReadBrokerResponseAsync(
            Stream pipe,
            CancellationToken cancellationToken)
    {
        byte[] header = new byte[BrokerResponseMagic.Length + 1 + sizeof(uint)];
        try
        {
            await ReadExactlyAsync(pipe, header, cancellationToken)
                .ConfigureAwait(false);
            if (!header.AsSpan(0, BrokerResponseMagic.Length)
                .SequenceEqual(BrokerResponseMagic))
            {
                throw new InvalidDataException();
            }

            BrokerStatus status =
                (BrokerStatus)header[BrokerResponseMagic.Length];
            uint payloadLength = BinaryPrimitives.ReadUInt32BigEndian(
                header.AsSpan(BrokerResponseMagic.Length + 1, sizeof(uint)));
            if ((status != BrokerStatus.Empty &&
                 status != BrokerStatus.Credential &&
                 status != BrokerStatus.Reject) ||
                payloadLength > MaximumCredentialPayloadBytes)
            {
                throw new InvalidDataException();
            }

            byte[] payload = new byte[(int)payloadLength];
            try
            {
                await ReadExactlyAsync(pipe, payload, cancellationToken)
                    .ConfigureAwait(false);
                return (status, payload);
            }
            catch
            {
                CryptographicOperations.ZeroMemory(payload);
                throw;
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(header);
        }
    }

    private static async Task WriteBrokerResponseAsync(
        Stream pipe,
        BrokerStatus status,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken)
    {
        byte[] header = new byte[BrokerResponseMagic.Length + 1 + sizeof(uint)];
        try
        {
            BrokerResponseMagic.CopyTo(header);
            header[BrokerResponseMagic.Length] = (byte)status;
            BinaryPrimitives.WriteUInt32BigEndian(
                header.AsSpan(BrokerResponseMagic.Length + 1, sizeof(uint)),
                checked((uint)payload.Length));
            await pipe.WriteAsync(header, cancellationToken).ConfigureAwait(false);
            if (!payload.IsEmpty)
            {
                await pipe.WriteAsync(payload, cancellationToken)
                    .ConfigureAwait(false);
            }

            await pipe.FlushAsync(cancellationToken).ConfigureAwait(false);
            await ReadHelperAcknowledgementAsync(pipe, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(header);
        }
    }

    private static async Task WriteHelperAcknowledgementAsync(
        Stream pipe,
        CancellationToken cancellationToken)
    {
        byte[] acknowledgement = HelperAcknowledgementMagic.ToArray();
        try
        {
            await pipe.WriteAsync(acknowledgement, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(acknowledgement);
        }
    }

    private static async Task ReadHelperAcknowledgementAsync(
        Stream pipe,
        CancellationToken cancellationToken)
    {
        using var timeout =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(HelperTimeoutMilliseconds);
        byte[] acknowledgement = new byte[HelperAcknowledgementMagic.Length];
        try
        {
            await ReadExactlyAsync(pipe, acknowledgement, timeout.Token)
                .ConfigureAwait(false);
            if (!acknowledgement.AsSpan()
                .SequenceEqual(HelperAcknowledgementMagic))
            {
                throw new InvalidDataException();
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(acknowledgement);
        }
    }

    private static async Task<byte[]> ReadLengthPrefixedAsync(
        Stream input,
        int maximumLength,
        CancellationToken cancellationToken)
    {
        uint length = await ReadUInt32Async(input, cancellationToken)
            .ConfigureAwait(false);
        if (length > maximumLength)
        {
            throw new InvalidDataException();
        }

        byte[] value = new byte[(int)length];
        try
        {
            await ReadExactlyAsync(input, value, cancellationToken)
                .ConfigureAwait(false);
            return value;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(value);
            throw;
        }
    }

    private static async Task<uint> ReadUInt32Async(
        Stream input,
        CancellationToken cancellationToken)
    {
        byte[] bytes = new byte[sizeof(uint)];
        try
        {
            await ReadExactlyAsync(input, bytes, cancellationToken)
                .ConfigureAwait(false);
            return BinaryPrimitives.ReadUInt32BigEndian(bytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static async Task ReadExactlyAsync(
        Stream input,
        Memory<byte> destination,
        CancellationToken cancellationToken)
    {
        int offset = 0;
        while (offset < destination.Length)
        {
            int received = await input.ReadAsync(
                    destination[offset..],
                    cancellationToken)
                .ConfigureAwait(false);
            if (received == 0)
            {
                throw new EndOfStreamException();
            }

            offset += received;
        }
    }

    private static async Task<BoundedInput> ReadBoundedToEndAsync(
        Stream input,
        int maximumLength,
        CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[maximumLength + 1];
        int received = 0;
        try
        {
            while (received < buffer.Length)
            {
                int count = await input.ReadAsync(
                        buffer.AsMemory(received),
                        cancellationToken)
                    .ConfigureAwait(false);
                if (count == 0)
                {
                    break;
                }

                received += count;
            }

            if (received > maximumLength)
            {
                throw new InvalidDataException();
            }

            return new BoundedInput(buffer, received);
        }
        catch
        {
            CryptographicOperations.ZeroMemory(buffer);
            throw;
        }
    }

    private static async Task MonitorParentLifetimeAsync(
        Stream input,
        CancellationTokenSource lifetime)
    {
        byte[] buffer = new byte[1];
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                int count = await input.ReadAsync(buffer, lifetime.Token)
                    .ConfigureAwait(false);
                if (count == 0)
                {
                    lifetime.Cancel();
                    return;
                }

                buffer[0] = 0;
            }
        }
        catch
        {
            lifetime.Cancel();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buffer);
        }
    }

    private static async Task ObserveMonitorAsync(Task monitor)
    {
        try
        {
            await monitor.WaitAsync(TimeSpan.FromMilliseconds(250))
                .ConfigureAwait(false);
        }
        catch
        {
            // Process exit is the final lifetime boundary.
        }
    }

    private static bool IsHostAscii(ReadOnlySpan<byte> value)
    {
        return IsAsciiRange(value, 0x21);
    }

    private static bool IsUsernameAscii(ReadOnlySpan<byte> value)
    {
        return IsAsciiRange(value, 0x20);
    }

    private static bool IsAsciiRange(
        ReadOnlySpan<byte> value,
        byte minimum)
    {
        foreach (byte current in value)
        {
            if (current < minimum || current > 0x7e)
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsSafeUtf8Line(
        ReadOnlySpan<byte> value,
        bool requireNonempty)
    {
        if (requireNonempty && value.IsEmpty)
        {
            return false;
        }

        while (!value.IsEmpty)
        {
            OperationStatus status = Rune.DecodeFromUtf8(
                value,
                out Rune rune,
                out int consumed);
            if (status != OperationStatus.Done || consumed <= 0)
            {
                return false;
            }

            UnicodeCategory category = Rune.GetUnicodeCategory(rune);
            if (category == UnicodeCategory.Control ||
                category == UnicodeCategory.Format ||
                category == UnicodeCategory.Surrogate ||
                category == UnicodeCategory.LineSeparator ||
                category == UnicodeCategory.ParagraphSeparator)
            {
                return false;
            }

            value = value[consumed..];
        }

        return true;
    }

    private static string BrokerInitializationMagicAsText() => "CCGITB1";

    private static void Zero(byte[]? value)
    {
        if (value is not null)
        {
            CryptographicOperations.ZeroMemory(value);
        }
    }
}
