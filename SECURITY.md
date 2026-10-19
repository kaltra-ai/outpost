# Security

The outpost holds a company's secrets and fronts its data. If you find a way to make it leak, bypass an allow-list, accept an unsigned or replayed request, or write where it should only read, please tell us before you tell anyone else.

- Write to hello@kaltra.ai with "security" in the subject.
- Include the version (`GET /v1/meta` reports it), the route, and the shortest reproduction you have.
- You will get a human reply within three business days, and a fix or a timeline within fourteen.

Do not test against an outpost you do not operate. Deploy your own from this repository (`wrangler.jsonc` is the template) and test there.

Supported: the latest release on the `main` branch. Older deployments are expected to update; a tenant applies releases on its own schedule, nothing is pushed into a tenant's account from outside.
