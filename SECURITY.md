# Security policy

## Supported versions

Security fixes are provided for the latest released minor line. The current
`main` branch may contain fixes intended for the next release. Users of older
release lines should upgrade before reporting a version-specific problem.

## Reporting a vulnerability

Please privately report a security vulnerability through GitHub's
**Security > Report a vulnerability** form for this repository. Do not open a
public issue containing an exploit, credential, private repository URL, source
code, or other sensitive evidence.

Include the affected version or commit, deployment mode, impact, minimal
reproduction steps, and whether the issue has been disclosed elsewhere. Use
synthetic data whenever possible. The maintainer will acknowledge a usable
report as soon as practical, coordinate validation and remediation privately,
and credit the reporter when requested and safe.

If GitHub private vulnerability reporting is unavailable, open a public issue
that contains no sensitive details and asks the maintainer to establish a
private channel.

## Scope

Security reports are especially welcome for authorization bypasses, outbound
request-policy bypasses, credential exposure, unsafe archive or Git handling,
persistence boundary violations, published-snapshot privacy failures, and
container privilege or filesystem-isolation defects.
