// contracts/payment_escrow/src/settlement_tests.rs
#![cfg(test)]

use super::*;
use crate::token_fallback::{TokenFallbackHandler, UnsupportedTokenError};
use core::cell::Cell;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, String,
};

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

fn init<'a>(
    env: &'a Env,
    contract_id: &Address,
    admin: &Address,
    token: &Address,
    fee_recipient: &Address,
    fee_bps: u32,
) -> PaymentEscrowContractClient<'a> {
    let client = PaymentEscrowContractClient::new(env, contract_id);
    client.initialize(admin, token, &DISPUTE_WINDOW, fee_recipient, &fee_bps);
    client
}

fn esc_id(env: &Env, s: &str) -> String {
    String::from_str(env, s)
}

fn create(
    env: &Env,
    client: &PaymentEscrowContractClient,
    depositor: &Address,
    beneficiary: &Address,
    id: &str,
    amount: i128,
) -> String {
    let escrow_id = esc_id(env, id);
    client.create_escrow(
        depositor,
        &escrow_id,
        beneficiary,
        &amount,
        &String::from_str(env, "Settlement test"),
        &0u64,
    );
    escrow_id
}

// ── A token whose transfers can be made to fail on demand ─────────────────────

const MODE_OK: u32 = 0;
const MODE_REJECT_TRANSFER: u32 = 1;
const MODE_REJECT_BALANCE: u32 = 2;

#[contracttype]
#[derive(Clone)]
enum FlakyKey {
    Mode,
    Balance(Address),
}

#[contract]
pub struct FlakyToken;

#[contractimpl]
impl FlakyToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&FlakyKey::Balance(to), &(balance + amount));
    }

    pub fn set_mode(env: Env, mode: u32) {
        env.storage().persistent().set(&FlakyKey::Mode, &mode);
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        let mode: u32 = env.storage().persistent().get(&FlakyKey::Mode).unwrap_or(MODE_OK);
        if mode == MODE_REJECT_BALANCE {
            panic!("balance rejected");
        }
        env.storage()
            .persistent()
            .get(&FlakyKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let mode: u32 = env.storage().persistent().get(&FlakyKey::Mode).unwrap_or(MODE_OK);
        if mode != MODE_OK {
            panic!("transfer rejected");
        }
        from.require_auth();
        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            panic!("insufficient balance");
        }
        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&FlakyKey::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&FlakyKey::Balance(to), &(to_balance + amount));
    }
}

struct Flaky<'a> {
    client: PaymentEscrowContractClient<'a>,
    contract_id: Address,
    token: Address,
    token_client: FlakyTokenClient<'a>,
    admin: Address,
    depositor: Address,
    beneficiary: Address,
    fee_recipient: Address,
}

/// An escrow contract paying out in a [`FlakyToken`], with a 5% fee.
fn flaky_setup(env: &Env) -> Flaky<'_> {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let depositor = Address::generate(env);
    let beneficiary = Address::generate(env);
    let fee_recipient = Address::generate(env);

    let token = env.register(FlakyToken, ());
    let token_client = FlakyTokenClient::new(env, &token);
    token_client.mint(&depositor, &50_000i128);

    let contract_id = setup_contract(env);
    let client = init(env, &contract_id, &admin, &token, &fee_recipient, 500);
    Flaky {
        client,
        contract_id,
        token,
        token_client,
        admin,
        depositor,
        beneficiary,
        fee_recipient,
    }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

#[test]
fn test_release_pays_beneficiary_and_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 50_000);
    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token, &fee_recipient, 500);

    let id = create(&env, &client, &depositor, &beneficiary, "settle-001", 10_000);
    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Pending);

    client.release(&admin, &id);

    let escrow = client.get_escrow(&id);
    assert_eq!(escrow.status, EscrowStatus::Released);
    assert!(escrow.resolved_at.is_some());

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&beneficiary), 9_500);
    assert_eq!(token_client.balance(&fee_recipient), 500);
    assert_eq!(token_client.balance(&contract_id), 0);
}

#[test]
fn test_refund_returns_full_amount_to_depositor() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 50_000);
    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token, &fee_recipient, 250);

    let id = create(&env, &client, &depositor, &beneficiary, "refund-001", 20_000);
    client.refund(&admin, &id);

    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Refunded);
    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&depositor), 50_000);
    assert_eq!(token_client.balance(&fee_recipient), 0);
}

#[test]
fn test_release_is_one_time_transition() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 20_000);
    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token, &admin, 0);

    let id = create(&env, &client, &depositor, &beneficiary, "once-001", 10_000);
    client.release(&admin, &id);

    let token_client = TokenClient::new(&env, &token);
    let beneficiary_bal = token_client.balance(&beneficiary);
    let contract_bal = token_client.balance(&contract_id);

    assert_eq!(client.try_release(&admin, &id), Err(Ok(Error::EscrowNotPending)));
    assert_eq!(token_client.balance(&beneficiary), beneficiary_bal);
    assert_eq!(token_client.balance(&contract_id), contract_bal);

    assert_eq!(client.try_refund(&admin, &id), Err(Ok(Error::EscrowNotPending)));
    assert_eq!(
        client.try_resolve_dispute(&admin, &id, &true),
        Err(Ok(Error::EscrowNotPending))
    );
    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Released);
}

#[test]
fn test_dispute_resolved_to_beneficiary_with_fee() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 50_000);
    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token, &fee_recipient, 500);

    let id = create(&env, &client, &depositor, &beneficiary, "lifecycle-001", 10_000);
    client.raise_dispute(&depositor, &id);
    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Disputed);

    client.resolve_dispute(&admin, &id, &true);
    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Released);

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&beneficiary), 9_500);
    assert_eq!(token_client.balance(&fee_recipient), 500);
}

#[test]
fn test_dispute_resolved_to_depositor_refunds_in_full() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let fee_recipient = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 50_000);
    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token, &fee_recipient, 250);

    let id = create(&env, &client, &depositor, &beneficiary, "lifecycle-002", 20_000);
    client.raise_dispute(&depositor, &id);
    client.resolve_dispute(&admin, &id, &false);

    assert_eq!(client.get_escrow(&id).status, EscrowStatus::Refunded);
    assert_eq!(TokenClient::new(&env, &token).balance(&depositor), 50_000);
}

#[test]
fn test_multi_escrow_scenario() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let depositor = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let token = setup_token(&env, &admin, &depositor, 100_000);
    let contract_id = setup_contract(&env);
    let client = init(&env, &contract_id, &admin, &token, &admin, 0);

    let first = create(&env, &client, &depositor, &beneficiary, "multi-0", 5_000);
    let second = create(&env, &client, &depositor, &beneficiary, "multi-1", 5_000);
    let third = create(&env, &client, &depositor, &beneficiary, "multi-2", 5_000);

    client.release(&admin, &first);
    client.refund(&admin, &second);
    client.raise_dispute(&depositor, &third);
    client.resolve_dispute(&admin, &third, &true);

    assert_eq!(client.get_escrow(&first).status, EscrowStatus::Released);
    assert_eq!(client.get_escrow(&second).status, EscrowStatus::Refunded);
    assert_eq!(client.get_escrow(&third).status, EscrowStatus::Released);
}

// ── Rejected token transfers must not leave an escrow settled (#890) ──────────

#[test]
fn test_rejected_release_transfer_leaves_escrow_pending() {
    let env = Env::default();
    let f = flaky_setup(&env);
    let id = create(&env, &f.client, &f.depositor, &f.beneficiary, "rej-rel", 10_000);

    f.token_client.set_mode(&MODE_REJECT_TRANSFER);
    assert!(f.client.try_release(&f.admin, &id).is_err());

    let escrow = f.client.get_escrow(&id);
    assert_eq!(escrow.status, EscrowStatus::Pending);
    assert_eq!(escrow.resolved_at, None);
    assert_eq!(f.token_client.balance(&f.contract_id), 10_000);
    assert_eq!(f.token_client.balance(&f.beneficiary), 0);
    assert_eq!(f.token_client.balance(&f.fee_recipient), 0);
}

#[test]
fn test_release_succeeds_once_the_token_accepts_transfers_again() {
    let env = Env::default();
    let f = flaky_setup(&env);
    let id = create(&env, &f.client, &f.depositor, &f.beneficiary, "rej-retry", 10_000);

    f.token_client.set_mode(&MODE_REJECT_TRANSFER);
    assert!(f.client.try_release(&f.admin, &id).is_err());

    f.token_client.set_mode(&MODE_OK);
    f.client.release(&f.admin, &id);

    assert_eq!(f.client.get_escrow(&id).status, EscrowStatus::Released);
    assert_eq!(f.token_client.balance(&f.beneficiary), 9_500);
    assert_eq!(f.token_client.balance(&f.fee_recipient), 500);
    assert_eq!(f.token_client.balance(&f.contract_id), 0);
}

#[test]
fn test_rejected_refund_transfer_leaves_escrow_pending() {
    let env = Env::default();
    let f = flaky_setup(&env);
    let id = create(&env, &f.client, &f.depositor, &f.beneficiary, "rej-ref", 10_000);

    f.token_client.set_mode(&MODE_REJECT_TRANSFER);
    assert!(f.client.try_refund(&f.admin, &id).is_err());

    let escrow = f.client.get_escrow(&id);
    assert_eq!(escrow.status, EscrowStatus::Pending);
    assert_eq!(escrow.resolved_at, None);
    assert_eq!(f.token_client.balance(&f.contract_id), 10_000);
}

#[test]
fn test_rejected_dispute_resolution_leaves_escrow_disputed() {
    for release_to_beneficiary in [true, false] {
        let env = Env::default();
        let f = flaky_setup(&env);
        let id = create(&env, &f.client, &f.depositor, &f.beneficiary, "rej-disp", 10_000);
        f.client.raise_dispute(&f.depositor, &id);

        f.token_client.set_mode(&MODE_REJECT_TRANSFER);
        assert!(f
            .client
            .try_resolve_dispute(&f.admin, &id, &release_to_beneficiary)
            .is_err());

        let escrow = f.client.get_escrow(&id);
        assert_eq!(escrow.status, EscrowStatus::Disputed);
        assert_eq!(escrow.resolved_at, None);
        assert_eq!(f.token_client.balance(&f.contract_id), 10_000);

        f.token_client.set_mode(&MODE_OK);
        f.client.resolve_dispute(&f.admin, &id, &release_to_beneficiary);
        assert!(f.client.get_escrow(&id).resolved_at.is_some());
    }
}

#[test]
fn test_escrow_stays_live_after_a_rejected_transfer() {
    let env = Env::default();
    let f = flaky_setup(&env);
    let id = create(&env, &f.client, &f.depositor, &f.beneficiary, "rej-live", 10_000);

    f.token_client.set_mode(&MODE_REJECT_TRANSFER);
    assert!(f.client.try_release(&f.admin, &id).is_err());

    // Still pending, so the dispute flow remains available.
    f.client.raise_dispute(&f.depositor, &id);
    assert_eq!(f.client.get_escrow(&id).status, EscrowStatus::Disputed);
}

// ── Fallback handler: state changes only after a successful transfer ──────────

#[test]
fn test_transfer_then_settle_skips_settlement_when_transfer_rejected() {
    let env = Env::default();
    let f = flaky_setup(&env);
    let settled = Cell::new(false);

    env.as_contract(&f.contract_id, || {
        TokenFallbackHandler::add_supported_token(&env, &f.admin, &f.token).unwrap();
    });
    f.token_client.mint(&f.contract_id, &1_000i128);
    f.token_client.set_mode(&MODE_REJECT_TRANSFER);

    let result = env.as_contract(&f.contract_id, || {
        TokenFallbackHandler::transfer_then_settle(
            &env,
            &f.token,
            &f.contract_id,
            &f.beneficiary,
            &1_000i128,
            || settled.set(true),
        )
    });

    assert_eq!(result, Err(UnsupportedTokenError::TransferFailed));
    assert!(!settled.get());
}

#[test]
fn test_transfer_then_settle_marks_settled_after_successful_transfer() {
    let env = Env::default();
    let f = flaky_setup(&env);
    let settled = Cell::new(false);

    env.as_contract(&f.contract_id, || {
        TokenFallbackHandler::add_supported_token(&env, &f.admin, &f.token).unwrap();
    });
    f.token_client.mint(&f.contract_id, &1_000i128);

    let result = env.as_contract(&f.contract_id, || {
        TokenFallbackHandler::transfer_then_settle(
            &env,
            &f.token,
            &f.contract_id,
            &f.beneficiary,
            &1_000i128,
            || settled.set(true),
        )
    });

    assert_eq!(result, Ok(()));
    assert!(settled.get());
    assert_eq!(f.token_client.balance(&f.beneficiary), 1_000);
}

#[test]
fn test_transfer_then_settle_skips_settlement_when_balance_probe_rejected() {
    let env = Env::default();
    let f = flaky_setup(&env);
    let settled = Cell::new(false);

    env.as_contract(&f.contract_id, || {
        TokenFallbackHandler::add_supported_token(&env, &f.admin, &f.token).unwrap();
    });
    f.token_client.set_mode(&MODE_REJECT_BALANCE);

    let result = env.as_contract(&f.contract_id, || {
        TokenFallbackHandler::transfer_then_settle(
            &env,
            &f.token,
            &f.contract_id,
            &f.beneficiary,
            &1_000i128,
            || settled.set(true),
        )
    });

    assert_eq!(result, Err(UnsupportedTokenError::TransferFailed));
    assert!(!settled.get());
}

#[test]
fn test_transfer_then_settle_skips_settlement_when_funds_insufficient_or_token_unsupported() {
    let env = Env::default();
    let f = flaky_setup(&env);
    let settled = Cell::new(false);

    // Token not on the allowlist.
    let unsupported = env.as_contract(&f.contract_id, || {
        TokenFallbackHandler::transfer_then_settle(
            &env,
            &f.token,
            &f.contract_id,
            &f.beneficiary,
            &1_000i128,
            || settled.set(true),
        )
    });
    assert_eq!(unsupported, Err(UnsupportedTokenError::TokenNotSupported));

    // Allowlisted, but the contract holds nothing.
    env.as_contract(&f.contract_id, || {
        TokenFallbackHandler::add_supported_token(&env, &f.admin, &f.token).unwrap();
    });
    let insufficient = env.as_contract(&f.contract_id, || {
        TokenFallbackHandler::transfer_then_settle(
            &env,
            &f.token,
            &f.contract_id,
            &f.beneficiary,
            &1_000i128,
            || settled.set(true),
        )
    });
    assert_eq!(insufficient, Err(UnsupportedTokenError::InsufficientBalance));
    assert!(!settled.get());
}
