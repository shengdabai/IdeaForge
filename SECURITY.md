# Security Policy

Please do not report vulnerabilities, exposed secrets, credentials, or private user data in public issues.

Use GitHub private vulnerability reporting when it is available for this repository. If it is not available, contact the repository owner through the profile contact channel.

If a secret is exposed, revoke or rotate it first, then remove it from Git history and close the related GitHub secret scanning alert only after verification.

The HTTP dashboard serves imported and generated documents with a CSP sandbox.
Their scripts can run, but cannot share the dashboard's origin or read its local archives.
Forms, popups, downloads, and same-origin storage are restricted by that sandbox.
These protections apply when using `forge serve`; opening HTML directly as a local file does not apply the server's security headers.
