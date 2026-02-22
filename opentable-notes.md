# OpenTable reverse engineering notes
all that it takes to make requests work again is new cookie value

## Core flow
1. Get availability (already have this query)
2. Create slot lock (can copy this)
3. Click on slot time, to make REST request (don't have this yet)
3. Reserve (not available through graphql api. use browser to navigate to reservation url and submit form to complete reservation. Requires user having card added to opentable before hand)

## OpenTable Reservation URL Structure

Full example reservation url: `https://www.opentable.com/booking/confirmation?availabilityToken=eyJ2IjoyLCJtIjowLCJwIjowLCJjIjo2LCJzIjowLCJuIjowfQ&correlationId=65e320ae-9dda-411a-8a88-d8ca157e8da4&creditCardRequired=true&dateTime=2026-03-04T12%3A00%3A00&partySize=2&points=100&pointsType=Standard&resoAttribute=default&rid=220387&slotHash=3122883308&isModify=false&isMandatory=false&cfe=true&st=Standard%3Ftc%3Dunselected&confirmationNumber=22802&securityToken=013Sgb4GgPtMWKkX4fpTAMYcm3fgMIr6czVjmDAtqRXgA1`

| URL Parameter | Value | Source |
|---|---|---|
| `availabilityToken` | `eyJ2IjoyLCJtIjow...` | Slot's `slotAvailabilityToken` |
| `correlationId` | `63789d00-f43e-...` | Query's `correlationId` |
| `dateTime` | `2026-02-27T11:30:00` | Query's `date` (`2026-02-27`) + slot's `timeOffsetMinutes` (`690` = 11h30m) |
| `partySize` | `2` | Query's `partySize` |
| `points` | `100` | Slot's `pointsValue` |
| `pointsType` | `Standard` | Slot's `pointsType` |
| `resoAttribute` | `default` | Slot's `attributes[0]` |
| `rid` | `220387` | Query's `restaurantIds[0]` |
| `slotHash` | `1145756676` | Slot's `slotHash` |
| `isMandatory` | `false` | Slot's `isMandatory` |
| `isModify` | `false` | Hardcoded (this is a new reservation, not a modification) |
| `st` | `Standard?tc=unselected` | Slot's `type` (`Standard`) + `?tc=unselected` (no table category selected) |
| `cfe` | `true` | Not directly in the data — likely a client-side feature flag |
| `creditCardRequired` | `true` | Not in the provided data — likely from restaurant-level metadata in the full API response |

__

## How can I use it / monetization?

Right now, just local.

In the future, api request.
Ideally paid in crypto per-use, using something like  x402 and/or zkp2p, for fast settlement, low fees, and easy
use by agents. just fund your agent with some USDC and have them call out to the API

### Case 1 (happy path).
`user`:
POST to /reserve

`reservation-server`:
Verify payment was provided
Verification passes

### Case 1.
`user`:
POST to /reserve

`reservation-server`:
If no payment, respond with 402, payment requested


### Case 3 (happy path).
`user`:
POST to /reserve

`reservation-server`:
Verify payment was provided
Verification passes

Use ZKP2P to accept Venmo / CashApp, etc, and receive USDC
Once USDC is received, (or ZKP2P is confirmed, is this possible?),
make reservation for user.

I can accept Fiat, by integrating ZKP2P, and receive USDC
Once I receive USDC, I can start the service for the user
If a user needs a refund (unable to get reservation for them),
then I can offramp USDC -> Fiat. Just might need to top up my USDC balance a bit to account for fees.
But, if there are enough profitable transactions and Fiat->USDC onramping in, I'll have plenty to fulfill the relatively
small amount for refunds, leaning on existing people in the ZKP2P network.


Key issue to solve:
payment verification.
Can I use ZKP2P attestation directly as the verification step in x402?
What does "/settle" look like?

## Notes on reversing persistedQuery extension graphql endpoints

> on reverse engineering persisted-query extesion to get full graphql api access: https://crawlee.dev/blog/graphql-persisted-query
