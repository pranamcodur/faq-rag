# Single Sign-On (SSO) FAQ

## What is SSO and who can use it?
SSO lets employees sign in with their company identity provider (Okta, Azure AD or Google Workspace) instead of a separate password. SSO is available on the Business and Enterprise plans.

## How do I configure SSO?
An admin opens Settings > Security > SSO, selects SAML 2.0, and uploads the identity provider metadata XML. Then set the ACS URL and Entity ID shown on the page in your identity provider. Test with one user before enforcing it.

## Can users still log in with a password after SSO is enforced?
No. Once SSO is enforced, password login is disabled for all non-admin users. Admins keep a break-glass password login in case the identity provider is unavailable.
