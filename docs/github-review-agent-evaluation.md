# GitHub review agent evaluation

## Goal

Assess practical options for automated pull request review in this repository.

## Current recommendation

Do not adopt a third-party PR review agent by default yet.

## Notes

- Native GitHub capabilities should be preferred when repository access, control, and setup simplicity matter.
- If a third-party review agent is later revisited, CodeRabbit is the most credible candidate to evaluate first.
- A custom workflow backed by the repository owner's own model API key can be a better fit when subscription or vendor constraints make GitHub-native review unavailable.
