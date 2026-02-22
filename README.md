# OpenTable Reservation Bot

Automated CLI for booking OpenTable reservations via browser automation and GraphQL APIs.

## Setup

1. Ensure you have a credit card added to OpenTable already! Most restaurants require this for reservation. To check if you have a card added, or to add one, go here: https://www.opentable.com/user/profile/payments

2. Copy the example env and fill in your details:

```bash
cp .env.example .env
vim .env
```

2. Install dependencies:

```bash
bun install
```

## Run

```bash
source .env && bun main.ts
```

## Flow

1. Opens Chrome with profile 4
2. Logs in via SMS verification (you'll be prompted for the code)
3. Navigates to the restaurant page and extracts the restaurant ID
4. Copies session cookies from the browser
5. Queries available time slots within your time range
6. Picks first available slot
7. Locks the selected slot via GraphQL mutation
8. Opens the booking details page, accepts terms, and submits the reservation
    > (Reservation not available through graphql api, and REST API requires official OpenTable partnership to get API token to use. So, use browser to navigate to reservation url and submit form to complete reservation. Requires user having card added to opentable before hand.)
