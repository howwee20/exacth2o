# ExactH2O controller simulator

This package exercises experiment specifications and watering decisions without
network access or greenhouse hardware. It follows the production sequence:

1. measure and record VWC;
2. decide whether watering is needed;
3. enforce interval and hourly limits;
4. issue a simulated valve action;
5. record independent simulated delivery evidence;
6. expose the resulting sensor response on a later measurement.

It is a staging proof tool, not a replacement for physical flow, weight, or
pressure verification.

```bash
npm test --prefix platform/controller-simulator
```
