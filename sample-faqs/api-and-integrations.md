# API and Integrations FAQ

## How do I get an API key?
An admin opens Settings > Developer > Create API key. The key is shown only once, so copy it somewhere safe right away. If you lose it, revoke it and create a new one.

## What are the API rate limits?
Each key is limited to 100 requests per minute. When you go over, the API returns status 429 with a Retry-After header telling you how many seconds to wait.

## How do webhooks work?
Add an HTTPS endpoint under Settings > Developer > Webhooks and choose the events you want. Each delivery is signed with an HMAC-SHA256 signature header. Failed deliveries are retried up to 5 times over 1 hour.

## Does enforcing SSO affect API keys?
No. API keys keep working after SSO is enforced, because SSO only applies to people signing in to the web app. Treat keys like passwords and rotate them regularly.
