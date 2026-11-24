// contracts/payment_escrow/src/test.rs
#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, String,
};
// return Err("Zero-address admin initialization not allowed");
// ── Helpers ───────────────────────────────────────────────────────────────────

const DISPUTE_WINDOW: u64 = 86_400;

fn setup_contract(env: &Env) -> Address {
    env.register(PaymentEscrowContract, ())
}

fn setup_token(env: &Env, admin: &Address, recipient: &Address, amount: i128) -> Address {
    let token_address = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    StellarAssetClient::new(env, &token_address)
        .mock_all_auths()
        .mint(recipient, &amount);
    token_address
}

fn advance_time(env: &Env, seconds: u64) {
    env.ledger().with_mut(|l| l.timestamp += seconds);
}

fn init<'a>(
    env: &'a Env,
    contract_id: &Address,
    admin: &Address,
    token: &Address,
) -> PaymentEscrowContractClient<'a> {
    let client = PaymentEscrowContractClient::new(env, contract_id);
    client.initialize(admin, token, &DISPUTE_WINDOW, admin, &250u32);
    client
}

// ── Initialisation ────────────────────────────────────────────────────────────

#[test]
fn test_initialize_success() {
    let env = Env::default();
    let contract_id = setup_contract(&env);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);

    env.mock_all_auths();
    let client = init(&env, &contract_id, &admin, &token);

    assert_eq!(client.admin(), admin);
    assert_eq!(client.payment_token(), token);
    assert_eq!(client.dispute_window(), DISPUTE_WINDOW);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_initialize_twice_fails() {
    let env = Env::default();
    let contract_id = setup_contract(&env);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);

    env.mock_all_auths();
    let client = PaymentEscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token, &DISPUTE_WINDOW, &admin, &250u32);
    client.initialize(&admin, &token, &DISPUTE_WINDOW, &admin, &250u32);
}

// ── Escrow creation ───────────────────────────────────────────────────────────

#[test]
fn test_create_escrow_success() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Security deposit – booking ws-001"),
        &0u64,
    );

    let escrow = client.get_escrow(&String::from_str(&env, "esc-001"));
    assert_eq!(escrow.depositor, depositor);
    assert_eq!(escrow.beneficiary, beneficiary);
    assert_eq!(escrow.amount, 5_000i128);
    assert_eq!(escrow.status, EscrowStatus::Pending);
    assert_eq!(escrow.dispute_window, DISPUTE_WINDOW);
    assert_eq!(escrow.release_after, 0u64);

    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 5_000);
    assert_eq!(TokenClient::new(&env, &token).balance(&depositor), 5_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #12)")]
fn test_create_escrow_depositor_equals_beneficiary_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let token = setup_token(&env, &admin, &user, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &user,
        &String::from_str(&env, "esc-001"),
        &user,
        &5_000i128,
        &String::from_str(&env, "Self-escrow"),
        &0u64,
    );
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_create_escrow_duplicate_id_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 20_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Deposit A"),
        &0u64,
    );
    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Deposit B"),
        &0u64,
    );
}

/// A rejected deposit must be completely inert: no escrow record, no index
/// entries and no token movement. Reusing the same escrow ID afterwards proves
/// that nothing was left behind by the failed call.
fn assert_invalid_deposit_leaves_storage_unchanged(amount: i128) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);
    let escrow_id = String::from_str(&env, "esc-invalid");
    let token_client = TokenClient::new(&env, &token);

    let depositor_before = token_client.balance(&depositor);
    let contract_before = token_client.balance(&contract_id);

    let result = client.try_create_escrow(
        &depositor,
        &escrow_id,
        &beneficiary,
        &amount,
        &String::from_str(&env, "Invalid deposit"),
        &0u64,
    );
    assert_eq!(result, Err(Ok(Error::InvalidAmount)));

    // No escrow record was stored.
    assert_eq!(
        client.try_get_escrow(&escrow_id),
        Err(Ok(Error::EscrowNotFound))
    );
    // Neither lookup index was touched.
    assert!(client.get_depositor_escrows(&depositor).is_empty());
    assert!(client.get_beneficiary_escrows(&beneficiary).is_empty());
    // No funds moved into or out of the contract.
    assert_eq!(token_client.balance(&depositor), depositor_before);
    assert_eq!(token_client.balance(&contract_id), contract_before);

    // The rejected ID is still free — a valid deposit with the same ID works.
    client.create_escrow(
        &depositor,
        &escrow_id,
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Valid deposit after rejection"),
        &0u64,
    );
    let escrow = client.get_escrow(&escrow_id);
    assert_eq!(escrow.amount, 5_000i128);
    assert_eq!(client.get_depositor_escrows(&depositor).len(), 1);
    assert_eq!(client.get_beneficiary_escrows(&beneficiary).len(), 1);
}

#[test]
fn test_create_escrow_zero_deposit_leaves_storage_unchanged() {
    assert_invalid_deposit_leaves_storage_unchanged(0i128);
}

#[test]
fn test_create_escrow_negative_deposit_leaves_storage_unchanged() {
    assert_invalid_deposit_leaves_storage_unchanged(-1i128);
}

// ── Admin release / refund ────────────────────────────────────────────────────

#[test]
fn test_release_sends_funds_to_beneficiary() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Deposit"),
        &0u64,
    );

    client.release(&admin, &String::from_str(&env, "esc-001"));

    let token_client = TokenClient::new(&env, &token);
    // 250 bps of 5_000 is 125; the beneficiary receives the remainder.
    assert_eq!(token_client.balance(&beneficiary), 4_875);
    assert_eq!(token_client.balance(&admin), 125);
    assert_eq!(token_client.balance(&contract_id), 0);

    let escrow = client.get_escrow(&String::from_str(&env, "esc-001"));
    assert_eq!(escrow.status, EscrowStatus::Released);
    assert!(escrow.resolved_at.is_some());
}

#[test]
fn test_refund_returns_funds_to_depositor() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Deposit"),
        &0u64,
    );

    client.refund(&admin, &String::from_str(&env, "esc-001"));

    assert_eq!(TokenClient::new(&env, &token).balance(&depositor), 10_000); // fully restored
    assert_eq!(TokenClient::new(&env, &token).balance(&contract_id), 0);

    let escrow = client.get_escrow(&String::from_str(&env, "esc-001"));
    assert_eq!(escrow.status, EscrowStatus::Refunded);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_release_non_admin_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Deposit"),
        &0u64,
    );

    // Unauthorized = 2
    client.release(&depositor, &String::from_str(&env, "esc-001"));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_release_already_released_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Deposit"),
        &0u64,
    );

    client.release(&admin, &String::from_str(&env, "esc-001"));
    // EscrowNotPending = 6
    client.release(&admin, &String::from_str(&env, "esc-001"));
}

// ── Dispute flow ──────────────────────────────────────────────────────────────

#[test]
fn test_raise_dispute_within_window() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Deposit"),
        &0u64,
    );

    // Advance by 1 hour — still within 24-hour window
    advance_time(&env, 3_600);
    client.raise_dispute(&depositor, &String::from_str(&env, "esc-001"));

    let escrow = client.get_escrow(&String::from_str(&env, "esc-001"));
    assert_eq!(escrow.status, EscrowStatus::Disputed);
    assert!(escrow.dispute_raised_at.is_some());
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_raise_dispute_after_window_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Deposit"),
        &0u64,
    );

    // Advance past the 24-hour window
    advance_time(&env, DISPUTE_WINDOW + 1);
    // DisputeWindowClosed = 8
    client.raise_dispute(&depositor, &String::from_str(&env, "esc-001"));
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_raise_dispute_when_window_zero_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    // Initialise with dispute window = 0 (disputes disabled)
    let client = PaymentEscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token, &0u64, &admin, &250u32);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "No-dispute deposit"),
        &0u64,
    );

    // DisputeWindowClosed = 8 because window == 0
    client.raise_dispute(&depositor, &String::from_str(&env, "esc-001"));
}

#[test]
fn test_resolve_dispute_releases_to_beneficiary() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 10_000);

    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.create_escrow(
        &depositor,
        &String::from_str(&env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(&env, "Deposit"),
        &0u64,
    );

    advance_time(&env, 3_600);
    client.raise_dispute(&depositor, &String::from_str(&env, "esc-001"));
    client.resolve_dispute(&admin, &String::from_str(&env, "esc-001"), &true);

    let token_client = TokenClient::new(&env, &token);
    // Same fee split applies when a dispute is resolved in the beneficiary's favour.
    assert_eq!(token_client.balance(&beneficiary), 4_875);
    assert_eq!(token_client.balance(&admin), 125);
    assert_eq!(token_client.balance(&contract_id), 0);

    let escrow = client.get_escrow(&String::from_str(&env, "esc-001"));
    assert_eq!(escrow.status, EscrowStatus::Released);
    assert!(escrow.resolved_at.is_some());
}

#[test]
fn test_initialize_rejects_fee_bps_above_10000() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = setup_contract(&env);
    let client = PaymentEscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);

    let result = client.try_initialize(&admin, &token, &DISPUTE_WINDOW, &admin, &10_001u32);
    assert_eq!(result, Err(Ok(Error::InvalidFeeBps)));

    // Rejected init must leave no partial state — a valid initialize call
    // afterwards must still succeed as if the first call never happened.
    client.initialize(&admin, &token, &DISPUTE_WINDOW, &admin, &250u32);
}

#[test]
fn test_initialize_accepts_fee_bps_at_exactly_10000() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = setup_contract(&env);
    let client = PaymentEscrowContractClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);

    // 10,000 bps (100%) is the legal boundary, not an off-by-one error.
    client.initialize(&admin, &token, &DISPUTE_WINDOW, &admin, &10_000u32);
    assert_eq!(client.fee_bps(), 10_000u32);
}

#[test]
fn test_set_fee_bps_rejects_value_above_10000() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = setup_contract(&env);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let client = init(&env, &contract_id, &admin, &token);

    let before = client.fee_bps();
    let result = client.try_set_fee_bps(&admin, &10_001u32);
    assert_eq!(result, Err(Ok(Error::InvalidFeeBps)));

    // Rejected update must leave the previously-configured fee untouched.
    assert_eq!(client.fee_bps(), before);
}

#[test]
fn test_set_fee_bps_accepts_valid_value() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = setup_contract(&env);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.set_fee_bps(&admin, &500u32);
    assert_eq!(client.fee_bps(), 500u32);
}

#[test]
fn test_set_fee_recipient_rejects_unauthorized_caller() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = setup_contract(&env);
    let admin = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    let token = Address::generate(&env);
    let original_recipient = Address::generate(&env);
    let new_recipient = Address::generate(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.set_fee_recipient(&admin, &original_recipient);
    let result = client.try_set_fee_recipient(&unauthorized, &new_recipient);

    assert_eq!(result, Err(Ok(Error::Unauthorized)));
    assert_eq!(client.fee_recipient(), original_recipient);
}

#[test]
fn test_set_fee_recipient_accepts_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = setup_contract(&env);
    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let original_recipient = Address::generate(&env);
    let new_recipient = Address::generate(&env);
    let client = init(&env, &contract_id, &admin, &token);

    client.set_fee_recipient(&admin, &original_recipient);
    client.set_fee_recipient(&admin, &new_recipient);

    assert_eq!(client.fee_recipient(), new_recipient);
}

// ── Dispute deadline boundary ─────────────────────────────────────────────────

fn escrow_with_window(env: &Env, created_at: u64, dispute_window: u64) -> Escrow {
    Escrow {
        id: String::from_str(env, "esc-boundary"),
        depositor: Address::generate(env),
        beneficiary: Address::generate(env),
        amount: 1_000,
        payment_token: Address::generate(env),
        status: EscrowStatus::Pending,
        description: String::from_str(env, "Boundary"),
        created_at,
        release_after: 0,
        dispute_window,
        dispute_raised_at: None,
        resolved_at: None,
        fee_recipient: Address::generate(env),
        fee_bps: 0,
        fee_amount: 0,
    }
}

fn create_boundary_escrow<'a>(
    env: &'a Env,
) -> (PaymentEscrowContractClient<'a>, Address) {
    let admin = Address::generate(env);
    let depositor = Address::generate(env);
    let beneficiary = Address::generate(env);
    let token = setup_token(env, &admin, &depositor, 10_000);
    let contract_id = setup_contract(env);
    let client = init(env, &contract_id, &admin, &token);
    client.create_escrow(
        &depositor,
        &String::from_str(env, "esc-001"),
        &beneficiary,
        &5_000i128,
        &String::from_str(env, "Deposit"),
        &0u64,
    );
    (client, depositor)
}

#[test]
fn test_raise_dispute_at_exact_deadline_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, depositor) = create_boundary_escrow(&env);

    // created_at + dispute_window is the last accepted timestamp.
    advance_time(&env, DISPUTE_WINDOW);
    client.raise_dispute(&depositor, &String::from_str(&env, "esc-001"));

    let escrow = client.get_escrow(&String::from_str(&env, "esc-001"));
    assert_eq!(escrow.status, EscrowStatus::Disputed);
    assert_eq!(escrow.dispute_raised_at, Some(escrow.created_at + DISPUTE_WINDOW));
}

#[test]
fn test_raise_dispute_one_second_before_deadline_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, depositor) = create_boundary_escrow(&env);

    advance_time(&env, DISPUTE_WINDOW - 1);
    client.raise_dispute(&depositor, &String::from_str(&env, "esc-001"));

    let escrow = client.get_escrow(&String::from_str(&env, "esc-001"));
    assert_eq!(escrow.status, EscrowStatus::Disputed);
}

#[test]
fn test_raise_dispute_one_second_after_deadline_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, depositor) = create_boundary_escrow(&env);

    advance_time(&env, DISPUTE_WINDOW + 1);
    let result = client.try_raise_dispute(&depositor, &String::from_str(&env, "esc-001"));
    assert_eq!(result, Err(Ok(Error::DisputeWindowClosed)));

    // A rejected dispute must leave the escrow untouched.
    let escrow = client.get_escrow(&String::from_str(&env, "esc-001"));
    assert_eq!(escrow.status, EscrowStatus::Pending);
    assert_eq!(escrow.dispute_raised_at, None);
}

#[test]
fn test_is_dispute_window_open_boundaries() {
    let env = Env::default();
    let escrow = escrow_with_window(&env, 1_000, 500);

    assert_eq!(escrow.dispute_deadline(), Some(1_500));
    assert!(escrow.is_dispute_window_open(1_000));
    assert!(escrow.is_dispute_window_open(1_499));
    assert!(escrow.is_dispute_window_open(1_500), "deadline is inclusive");
    assert!(!escrow.is_dispute_window_open(1_501));
}

#[test]
fn test_is_dispute_window_open_false_when_disabled() {
    let env = Env::default();
    let escrow = escrow_with_window(&env, 1_000, 0);

    assert_eq!(escrow.dispute_deadline(), None);
    assert!(!escrow.is_dispute_window_open(1_000));
    assert!(!escrow.is_dispute_window_open(0));
}

#[test]
fn test_is_dispute_window_open_fails_closed_on_overflow() {
    let env = Env::default();
    let escrow = escrow_with_window(&env, u64::MAX, 1);

    assert_eq!(escrow.dispute_deadline(), None);
    assert!(!escrow.is_dispute_window_open(u64::MAX));
}
