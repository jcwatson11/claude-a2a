---
name: cr
description: Perform a comprehensive code review covering security, architecture, efficiency, error handling, type safety, concurrency, resilience, observability, tests, and code cleanliness.
argument-hint: "[file, directory, or description of what to review]"
---

# Comprehensive Code Review

Perform a thorough code review of $ARGUMENTS. If no specific target is given, review the entire project.

Work through each of the following sections in order. For each section, provide specific findings with file paths and line numbers. Do not give generic advice — every finding must reference actual code. If you need to research any protocols, standards, or libraries involved, do so before making claims.

## 1. Security

- What vulnerabilities does this code expose? What attack vectors exist?
- Check for: command injection, path traversal, XSS, SQL injection, prototype pollution, ReDoS, and other OWASP Top 10 risks.
- Are secrets (keys, tokens, passwords) handled correctly? Could they leak via logs, errors, or responses?
- Is authentication and authorization implemented correctly? Are there bypass paths?
- Is input validated and sanitized at every system boundary (user input, external APIs, file reads, env vars)?
- Are dependencies free of known vulnerabilities? Run `npm audit` or equivalent if applicable.
- Are current mitigations sufficient, or are they security theater?

## 2. Architecture

- Does the architecture follow established best practices for the language and framework?
- Is it DRY? Identify any duplicated logic that should be consolidated.
- Are concerns properly separated? Is the dependency graph clean, or are there circular or inappropriate dependencies?
- Does it use service classes, modules, and abstractions at the right level — not too many, not too few?
- Does it follow the standards and protocols it implements accurately? Research protocol specs if needed.
- Are public interfaces and module boundaries well-defined? Would a new developer understand where to make changes?
- Are there signs of over-engineering (premature abstractions, unused extension points, unnecessary indirection)?

## 3. Error Handling

- Are all error paths handled? Are there unhandled promise rejections or uncaught exceptions?
- Do errors propagate correctly, or are they silently swallowed?
- Are error messages useful for debugging without leaking internal details to end users?
- Is there a consistent error handling strategy, or does each module do it differently?
- Are resources (file handles, connections, subprocesses, timers) properly cleaned up on error?
- Are expected failure cases (network timeouts, missing files, bad input) handled differently from unexpected bugs?

## 4. Type Safety

- Are types used effectively? Are there `any` types, type assertions, or `@ts-ignore` comments that mask real issues?
- Are function signatures explicit about what they accept and return, including null/undefined?
- Are discriminated unions, generics, and utility types used where they would improve safety?
- Could any runtime type errors slip through that the type system should have caught?

## 5. Concurrency & State

- Are there shared mutable state issues? Could concurrent requests corrupt data?
- Are async operations handled correctly? Look for: missing `await`, floating promises, and race conditions.
- Are resources (connections, subprocesses, file locks) properly managed across concurrent access?
- Could the system deadlock or starve under load?

## 6. Resilience

- What happens when external dependencies fail (network, filesystem, subprocesses, APIs)?
- Are there appropriate timeouts on all external calls?
- Is there graceful degradation, or does one failure cascade through the system?
- Are retries implemented where appropriate? Do they use backoff to avoid thundering herds?
- What is the startup and shutdown behavior? Are in-flight requests handled on shutdown?

## 7. Efficiency

- Are there more efficient ways to accomplish what this code does?
- Look for: unnecessary allocations, O(n) operations that could be O(1), redundant I/O, missing caching opportunities, excessive subprocess spawning, and N+1 patterns.
- Are there memory leaks (growing maps/arrays/caches without eviction, uncleaned event listeners)?
- What other approaches might we consider? Is this the best one?

## 8. Observability

- Is there sufficient logging to debug production issues? Can you trace a request from entry to response?
- Are log levels appropriate (debug vs info vs warn vs error)?
- Are sensitive values excluded from logs?
- Are metrics, health checks, and status endpoints adequate for monitoring?
- When something goes wrong at 3 AM, would the logs tell you what happened?

## 9. Configuration & Defaults

- Are defaults sensible and secure? Would a naive deployment be safe?
- Is all configuration validated at startup rather than failing at runtime?
- Are there hardcoded values that should be configurable?
- Is the configuration documented and are the units clear (seconds vs milliseconds, bytes vs megabytes)?

## 10. Unit Tests

- Do the tests actually verify the behavior they claim to test, or are they just exercising code paths?
- Are there important cases that are not tested?
- Are there edge cases (empty input, boundary values, concurrent access, error paths) that need coverage?
- Are there false presumptions in the tests — mocks that don't match real behavior, assertions that would pass even if the code were broken?
- Do the tests test behavior (what the code does) rather than implementation (how it does it)?
- Would a bug in the code actually cause a test to fail, or would the tests still pass?

## 11. Clean

- Run the linter and report any issues.
- Run the full test suite and report any failures.
- Flag dead code, unused imports, and inconsistent naming.
- Are naming conventions consistent throughout (casing, terminology, abbreviations)?
- Is the code readable without comments, and are non-obvious decisions explained where needed?

## Summary

After completing all sections, provide:

1. **Rating per section**: Grade each as **Good**, **Acceptable**, **Needs Work**, or **Critical**.
2. **Critical issues**: Anything that must be fixed before this code should run in production.
3. **Important issues**: Things that should be fixed soon, ordered by severity.
4. **Quick wins**: Low-effort improvements that would meaningfully improve quality.
5. **Overall assessment**: A brief honest evaluation of the codebase's production-readiness.
