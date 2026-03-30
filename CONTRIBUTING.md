# Contributing to EasySkills

Thanks for your interest in contributing to EasySkills.

## Before You Start

- Read the main [README](./README.md) first
- Make sure your changes fit the project scope: online Skill generation, document parsing, OCR, packaging, and lightweight PHP deployment
- Open an issue before large refactors or feature rewrites so the direction is aligned early

## Development Principles

- Keep the project lightweight and easy to deploy
- Prefer simple native HTML, CSS, JavaScript, and PHP solutions
- Preserve the current product direction: no heavy framework or build step unless there is a strong reason
- Do not commit real API keys, secrets, or private deployment information
- Keep user-facing copy clear and practical

## Recommended Workflow

1. Fork the repository
2. Create a feature branch
3. Make focused changes
4. Test the relevant flow manually
5. Update documentation when behavior changes
6. Open a pull request with a clear summary

## What to Include in a Pull Request

- What changed
- Why the change is needed
- Any user-facing impact
- Manual test steps
- Screenshots or screen recordings for UI changes when possible

## Manual Testing Checklist

When your change touches the core flow, please test as many of these as possible:

- Upload a text file and generate a Skill
- Paste plain text and generate a Skill
- Fetch a web page and verify the extracted content
- Verify model selection still works
- Verify custom API mode still works
- Download both `.skill` and `.zip`
- Confirm the generated preview is readable
- If OCR-related code changed, test at least one scanned PDF

## Coding Style

- Use readable, straightforward code
- Keep comments short and useful
- Match the existing naming and file organization
- Avoid unrelated formatting-only changes in the same PR

## Documentation

Please update the following when relevant:

- [README.md](./README.md)
- [README_EN.md](./README_EN.md)
- deployment or configuration examples

## Security

If you find a security issue, please avoid opening a public issue with exploit details immediately. Contact the maintainer first and provide a short reproduction summary.

## Maintainer

- GitHub: `majiabin2020`
