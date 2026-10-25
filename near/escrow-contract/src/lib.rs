use borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::collections::LookupMap;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, env, ext_contract, near,
    require,
};

const CONTRACT_VERSION: &str = "air-otc-private-pool/2";
const MAX_HASH_LENGTH: usize = 64;
const MAX_AUTHORIZATION_WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
const MAX_ROTATION_DELAY_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
const MAX_WITHDRAWAL_WINDOW_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
const EMERGENCY_RECOVERY_DELAY_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
const CALLBACK_GAS: Gas = Gas::from_tgas(5);
const MAX_WITHDRAWAL_ATTEMPTS: u8 = 3;

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Deposits,
    Withdrawals,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct DepositRecord {
    depositor_id: AccountId,
    amount: u128,
    storage_fee: u128,
    deposited_at_ns: u64,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Copy, PartialEq, Eq)]
pub enum WithdrawalStatus {
    Pending,
    Completed,
    Failed,
}

impl WithdrawalStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Completed => "COMPLETED",
            Self::Failed => "FAILED",
        }
    }
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct WithdrawalRecord {
    recipient_id: AccountId,
    amount: u128,
    expiry_ns: u64,
    ledger_root: String,
    status: WithdrawalStatus,
    attempts: u8,
    window_started_at_ns: u64,
    started_at_ns: u64,
    completed_at_ns: u64,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct PendingWorker {
    account_id: AccountId,
    measurement_hash: String,
    encryption_key_hash: String,
    activate_after_ns: u64,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct PendingRecovery {
    account_id: AccountId,
    measurement_hash: String,
    encryption_key_hash: String,
    execute_after_ns: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PoolInitConfig {
    owner_id: AccountId,
    tee_worker_id: AccountId,
    tee_measurement_hash: String,
    tee_encryption_key_hash: String,
    min_deposit: U128,
    max_withdrawal: U128,
    max_withdrawal_per_window: U128,
    withdrawal_window_ns: U64,
    rotation_delay_ns: U64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ConfigView {
    version: &'static str,
    owner_id: AccountId,
    tee_worker_id: AccountId,
    tee_measurement_hash: String,
    tee_encryption_key_hash: String,
    pending_worker: Option<PendingWorkerView>,
    pending_recovery: Option<PendingRecoveryView>,
    paused: bool,
    min_deposit: U128,
    max_withdrawal: U128,
    max_withdrawal_per_window: U128,
    withdrawal_window_ns: U64,
    withdrawal_window_started_at_ns: U64,
    withdrawn_in_window: U128,
    rotation_delay_ns: U64,
    pool_liability: U128,
    latest_ledger_root: String,
    latest_ledger_sequence: U64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PendingWorkerView {
    account_id: AccountId,
    measurement_hash: String,
    encryption_key_hash: String,
    activate_after_ns: U64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PendingRecoveryView {
    account_id: AccountId,
    measurement_hash: String,
    encryption_key_hash: String,
    execute_after_ns: U64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct DepositView {
    commitment: String,
    depositor_id: AccountId,
    amount: U128,
    storage_fee: U128,
    deposited_at_ns: U64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct WithdrawalView {
    withdrawal_id: String,
    recipient_id: AccountId,
    amount: U128,
    expiry_ns: U64,
    ledger_root: String,
    status: String,
    attempts: u8,
    window_started_at_ns: U64,
    started_at_ns: U64,
    completed_at_ns: U64,
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait ExtSelf {
    fn on_withdraw_complete(&mut self, withdrawal_id: String) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PrivatePool {
    owner_id: AccountId,
    tee_worker_id: AccountId,
    tee_measurement_hash: String,
    tee_encryption_key_hash: String,
    pending_worker: Option<PendingWorker>,
    pending_recovery: Option<PendingRecovery>,
    paused: bool,
    min_deposit: u128,
    max_withdrawal: u128,
    max_withdrawal_per_window: u128,
    withdrawal_window_ns: u64,
    withdrawal_window_started_at_ns: u64,
    withdrawn_in_window: u128,
    rotation_delay_ns: u64,
    pool_liability: u128,
    latest_ledger_root: String,
    latest_ledger_sequence: u64,
    deposits: LookupMap<String, DepositRecord>,
    withdrawals: LookupMap<String, WithdrawalRecord>,
}

#[near]
impl PrivatePool {
    #[init]
    pub fn new(config: PoolInitConfig) -> Self {
        let PoolInitConfig {
            owner_id,
            tee_worker_id,
            tee_measurement_hash,
            tee_encryption_key_hash,
            min_deposit,
            max_withdrawal,
            max_withdrawal_per_window,
            withdrawal_window_ns,
            rotation_delay_ns,
        } = config;
        require_hash(&tee_measurement_hash, "tee_measurement_hash");
        require_hash(&tee_encryption_key_hash, "tee_encryption_key_hash");
        require!(min_deposit.0 > 0, "min_deposit must be greater than zero");
        require!(
            max_withdrawal.0 > 0,
            "max_withdrawal must be greater than zero"
        );
        require!(
            max_withdrawal_per_window.0 >= max_withdrawal.0,
            "window limit must be at least max_withdrawal"
        );
        require!(
            withdrawal_window_ns.0 > 0 && withdrawal_window_ns.0 <= MAX_WITHDRAWAL_WINDOW_NS,
            "withdrawal_window_ns is outside the allowed range"
        );
        require!(
            rotation_delay_ns.0 > 0 && rotation_delay_ns.0 <= MAX_ROTATION_DELAY_NS,
            "rotation_delay_ns is outside the allowed range"
        );
        Self {
            owner_id,
            tee_worker_id,
            tee_measurement_hash,
            tee_encryption_key_hash,
            pending_worker: None,
            pending_recovery: None,
            paused: false,
            min_deposit: min_deposit.0,
            max_withdrawal: max_withdrawal.0,
            max_withdrawal_per_window: max_withdrawal_per_window.0,
            withdrawal_window_ns: withdrawal_window_ns.0,
            withdrawal_window_started_at_ns: env::block_timestamp(),
            withdrawn_in_window: 0,
            rotation_delay_ns: rotation_delay_ns.0,
            pool_liability: 0,
            latest_ledger_root: String::new(),
            latest_ledger_sequence: 0,
            deposits: LookupMap::new(StorageKey::Deposits),
            withdrawals: LookupMap::new(StorageKey::Withdrawals),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            version: CONTRACT_VERSION,
            owner_id: self.owner_id.clone(),
            tee_worker_id: self.tee_worker_id.clone(),
            tee_measurement_hash: self.tee_measurement_hash.clone(),
            tee_encryption_key_hash: self.tee_encryption_key_hash.clone(),
            pending_worker: self
                .pending_worker
                .as_ref()
                .map(|worker| PendingWorkerView {
                    account_id: worker.account_id.clone(),
                    measurement_hash: worker.measurement_hash.clone(),
                    encryption_key_hash: worker.encryption_key_hash.clone(),
                    activate_after_ns: U64(worker.activate_after_ns),
                }),
            pending_recovery: self
                .pending_recovery
                .as_ref()
                .map(|recovery| PendingRecoveryView {
                    account_id: recovery.account_id.clone(),
                    measurement_hash: recovery.measurement_hash.clone(),
                    encryption_key_hash: recovery.encryption_key_hash.clone(),
                    execute_after_ns: U64(recovery.execute_after_ns),
                }),
            paused: self.paused,
            min_deposit: U128(self.min_deposit),
            max_withdrawal: U128(self.max_withdrawal),
            max_withdrawal_per_window: U128(self.max_withdrawal_per_window),
            withdrawal_window_ns: U64(self.withdrawal_window_ns),
            withdrawal_window_started_at_ns: U64(self.withdrawal_window_started_at_ns),
            withdrawn_in_window: U128(self.withdrawn_in_window),
            rotation_delay_ns: U64(self.rotation_delay_ns),
            pool_liability: U128(self.pool_liability),
            latest_ledger_root: self.latest_ledger_root.clone(),
            latest_ledger_sequence: U64(self.latest_ledger_sequence),
        }
    }

    pub fn get_deposit(&self, depositor_id: AccountId, commitment: String) -> Option<DepositView> {
        let key = deposit_key(&depositor_id, &commitment);
        self.deposits.get(&key).map(|record| DepositView {
            commitment,
            depositor_id: record.depositor_id,
            amount: U128(record.amount),
            storage_fee: U128(record.storage_fee),
            deposited_at_ns: U64(record.deposited_at_ns),
        })
    }

    pub fn get_withdrawal(&self, withdrawal_id: String) -> Option<WithdrawalView> {
        self.withdrawals
            .get(&withdrawal_id)
            .map(|record| withdrawal_view(withdrawal_id, record))
    }

    pub fn is_withdrawal_finalized(&self, withdrawal_id: String) -> bool {
        self.withdrawals
            .get(&withdrawal_id)
            .is_some_and(|record| record.status == WithdrawalStatus::Completed)
    }

    #[payable]
    pub fn deposit(&mut self, commitment: String) -> U128 {
        self.require_not_paused();
        require_hash(&commitment, "commitment");
        let depositor_id = env::predecessor_account_id();
        let key = deposit_key(&depositor_id, &commitment);
        require!(
            self.deposits.get(&key).is_none(),
            "commitment already exists"
        );

        let attached = env::attached_deposit().as_yoctonear();
        let storage_before = env::storage_usage();
        self.deposits.insert(
            &key,
            &DepositRecord {
                depositor_id: depositor_id.clone(),
                amount: 0,
                storage_fee: 0,
                deposited_at_ns: env::block_timestamp(),
            },
        );
        let storage_bytes = env::storage_usage()
            .checked_sub(storage_before)
            .unwrap_or_else(|| env::panic_str("storage accounting underflow"));
        let storage_fee = env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(storage_bytes))
            .unwrap_or_else(|| env::panic_str("storage fee overflow"));
        let amount = attached
            .checked_sub(storage_fee)
            .unwrap_or_else(|| env::panic_str("attached deposit does not cover storage"));
        require!(
            amount >= self.min_deposit,
            "credited deposit is below min_deposit"
        );

        self.deposits.insert(
            &key,
            &DepositRecord {
                depositor_id: depositor_id.clone(),
                amount,
                storage_fee,
                deposited_at_ns: env::block_timestamp(),
            },
        );
        self.pool_liability = self
            .pool_liability
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("pool liability overflow"));
        emit(
            "deposit",
            near_sdk::serde_json::json!({
                "commitment": commitment,
                "depositor_id": depositor_id,
                "amount": amount.to_string(),
                "storage_fee": storage_fee.to_string(),
            }),
        );
        U128(amount)
    }

    pub fn anchor_ledger_root(&mut self, root: String, sequence: U64) {
        self.require_not_paused();
        self.require_tee_worker();
        require_hash(&root, "root");
        if sequence.0 == self.latest_ledger_sequence {
            require!(
                root == self.latest_ledger_root,
                "ledger root conflicts with current sequence"
            );
            return;
        }
        require!(
            sequence.0 > self.latest_ledger_sequence,
            "ledger sequence must increase"
        );
        self.latest_ledger_root = root.clone();
        self.latest_ledger_sequence = sequence.0;
        emit(
            "ledger_root",
            near_sdk::serde_json::json!({ "root": root, "sequence": sequence.0.to_string() }),
        );
    }

    pub fn withdraw(
        &mut self,
        withdrawal_id: String,
        recipient_id: AccountId,
        amount: U128,
        expiry_ns: U64,
        ledger_root: String,
    ) -> Promise {
        self.require_not_paused();
        self.require_tee_worker();
        require_hash(&withdrawal_id, "withdrawal_id");
        require_hash(&ledger_root, "ledger_root");
        require!(
            !self.latest_ledger_root.is_empty(),
            "no ledger root has been anchored"
        );
        require!(
            ledger_root == self.latest_ledger_root,
            "ledger root is not current"
        );
        require!(amount.0 > 0, "withdrawal amount must be greater than zero");
        require!(
            amount.0 <= self.max_withdrawal,
            "withdrawal exceeds max_withdrawal"
        );
        let now = env::block_timestamp();
        require!(expiry_ns.0 > now, "withdrawal authorization expired");
        require!(
            expiry_ns.0 - now <= MAX_AUTHORIZATION_WINDOW_NS,
            "withdrawal authorization window is too long"
        );

        self.refresh_withdrawal_window(now);
        let updated_window_total = self
            .withdrawn_in_window
            .checked_add(amount.0)
            .unwrap_or_else(|| env::panic_str("withdrawal window total overflow"));
        require!(
            updated_window_total <= self.max_withdrawal_per_window,
            "withdrawal rate limit exceeded"
        );

        let attempts = match self.withdrawals.get(&withdrawal_id) {
            None => 1,
            Some(record) => {
                require!(
                    record.status == WithdrawalStatus::Failed,
                    "withdrawal already used"
                );
                require!(
                    record.recipient_id == recipient_id,
                    "retry recipient mismatch"
                );
                require!(record.amount == amount.0, "retry amount mismatch");
                require!(record.expiry_ns == expiry_ns.0, "retry expiry mismatch");
                require!(
                    record.ledger_root == ledger_root,
                    "retry ledger root mismatch"
                );
                require!(
                    record.attempts < MAX_WITHDRAWAL_ATTEMPTS,
                    "withdrawal retry limit reached"
                );
                record.attempts + 1
            }
        };

        require!(
            self.pool_liability >= amount.0,
            "insufficient pool liability"
        );
        self.withdrawn_in_window = updated_window_total;
        self.pool_liability -= amount.0;
        self.withdrawals.insert(
            &withdrawal_id,
            &WithdrawalRecord {
                recipient_id: recipient_id.clone(),
                amount: amount.0,
                expiry_ns: expiry_ns.0,
                ledger_root: ledger_root.clone(),
                status: WithdrawalStatus::Pending,
                attempts,
                window_started_at_ns: self.withdrawal_window_started_at_ns,
                started_at_ns: now,
                completed_at_ns: 0,
            },
        );
        emit(
            "withdrawal_started",
            near_sdk::serde_json::json!({
                "withdrawal_id": withdrawal_id,
                "recipient_id": recipient_id,
                "amount": amount.0.to_string(),
                "ledger_root": ledger_root,
                "attempt": attempts,
            }),
        );

        Promise::new(recipient_id)
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_withdraw_complete(withdrawal_id),
            )
    }

    #[private]
    pub fn on_withdraw_complete(&mut self, withdrawal_id: String) -> bool {
        let mut record = self
            .withdrawals
            .get(&withdrawal_id)
            .unwrap_or_else(|| env::panic_str("withdrawal not found"));
        require!(
            record.status == WithdrawalStatus::Pending,
            "withdrawal is not pending"
        );
        match env::promise_result_checked(0, 0) {
            Ok(_) => {
                record.status = WithdrawalStatus::Completed;
                record.completed_at_ns = env::block_timestamp();
                self.withdrawals.insert(&withdrawal_id, &record);
                emit(
                    "withdrawal_completed",
                    near_sdk::serde_json::json!({ "withdrawal_id": withdrawal_id }),
                );
                true
            }
            Err(_) => {
                record.status = WithdrawalStatus::Failed;
                self.pool_liability = self
                    .pool_liability
                    .checked_add(record.amount)
                    .unwrap_or_else(|| env::panic_str("pool liability overflow"));
                if self.withdrawal_window_started_at_ns == record.window_started_at_ns {
                    self.withdrawn_in_window = self
                        .withdrawn_in_window
                        .checked_sub(record.amount)
                        .unwrap_or_else(|| {
                            env::panic_str("withdrawal window accounting underflow")
                        });
                }
                self.withdrawals.insert(&withdrawal_id, &record);
                emit(
                    "withdrawal_failed",
                    near_sdk::serde_json::json!({ "withdrawal_id": withdrawal_id }),
                );
                false
            }
        }
    }

    pub fn propose_tee_worker(
        &mut self,
        account_id: AccountId,
        measurement_hash: String,
        encryption_key_hash: String,
    ) {
        self.require_owner();
        require!(
            self.pending_recovery.is_none(),
            "emergency recovery is pending"
        );
        require_hash(&measurement_hash, "measurement_hash");
        require_hash(&encryption_key_hash, "encryption_key_hash");
        let activate_after_ns = env::block_timestamp()
            .checked_add(self.rotation_delay_ns)
            .unwrap_or_else(|| env::panic_str("rotation timestamp overflow"));
        self.pending_worker = Some(PendingWorker {
            account_id: account_id.clone(),
            measurement_hash: measurement_hash.clone(),
            encryption_key_hash: encryption_key_hash.clone(),
            activate_after_ns,
        });
        emit(
            "tee_worker_proposed",
            near_sdk::serde_json::json!({
                "account_id": account_id,
                "measurement_hash": measurement_hash,
                "encryption_key_hash": encryption_key_hash,
                "activate_after_ns": activate_after_ns,
            }),
        );
    }

    pub fn cancel_tee_worker_proposal(&mut self) {
        self.require_owner();
        self.pending_worker = None;
        emit(
            "tee_worker_proposal_cancelled",
            near_sdk::serde_json::json!({}),
        );
    }

    pub fn activate_tee_worker(&mut self) {
        let pending = self
            .pending_worker
            .as_ref()
            .unwrap_or_else(|| env::panic_str("no pending TEE worker"));
        require!(
            env::block_timestamp() >= pending.activate_after_ns,
            "rotation delay has not elapsed"
        );
        let pending = self
            .pending_worker
            .take()
            .unwrap_or_else(|| env::panic_str("no pending TEE worker"));
        self.tee_worker_id = pending.account_id.clone();
        self.tee_measurement_hash = pending.measurement_hash.clone();
        self.tee_encryption_key_hash = pending.encryption_key_hash.clone();
        emit(
            "tee_worker_activated",
            near_sdk::serde_json::json!({
                "account_id": pending.account_id,
                "measurement_hash": pending.measurement_hash,
                "encryption_key_hash": pending.encryption_key_hash,
            }),
        );
    }

    pub fn begin_emergency_recovery(
        &mut self,
        account_id: AccountId,
        measurement_hash: String,
        encryption_key_hash: String,
    ) {
        self.require_owner();
        require_hash(&measurement_hash, "measurement_hash");
        require_hash(&encryption_key_hash, "encryption_key_hash");
        require!(
            self.pending_recovery.is_none(),
            "emergency recovery already pending"
        );
        let execute_after_ns = env::block_timestamp()
            .checked_add(EMERGENCY_RECOVERY_DELAY_NS)
            .unwrap_or_else(|| env::panic_str("recovery timestamp overflow"));
        self.paused = true;
        self.pending_worker = None;
        self.pending_recovery = Some(PendingRecovery {
            account_id: account_id.clone(),
            measurement_hash: measurement_hash.clone(),
            encryption_key_hash: encryption_key_hash.clone(),
            execute_after_ns,
        });
        emit(
            "emergency_recovery_started",
            near_sdk::serde_json::json!({
                "account_id": account_id,
                "measurement_hash": measurement_hash,
                "encryption_key_hash": encryption_key_hash,
                "execute_after_ns": execute_after_ns.to_string(),
            }),
        );
    }

    pub fn cancel_emergency_recovery(&mut self) {
        self.require_owner();
        require!(
            self.pending_recovery.is_some(),
            "no emergency recovery is pending"
        );
        self.pending_recovery = None;
        emit(
            "emergency_recovery_cancelled",
            near_sdk::serde_json::json!({}),
        );
    }

    pub fn execute_emergency_recovery(&mut self) {
        let recovery = self
            .pending_recovery
            .as_ref()
            .unwrap_or_else(|| env::panic_str("no emergency recovery is pending"));
        require!(
            env::block_timestamp() >= recovery.execute_after_ns,
            "emergency recovery delay has not elapsed"
        );
        let recovery = self
            .pending_recovery
            .take()
            .unwrap_or_else(|| env::panic_str("no emergency recovery is pending"));
        self.tee_worker_id = recovery.account_id.clone();
        self.tee_measurement_hash = recovery.measurement_hash.clone();
        self.tee_encryption_key_hash = recovery.encryption_key_hash.clone();
        emit(
            "emergency_recovery_executed",
            near_sdk::serde_json::json!({
                "account_id": recovery.account_id,
                "measurement_hash": recovery.measurement_hash,
                "encryption_key_hash": recovery.encryption_key_hash,
                "paused": self.paused,
            }),
        );
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.require_owner();
        if !paused {
            require!(
                self.pending_recovery.is_none(),
                "emergency recovery is pending"
            );
        }
        self.paused = paused;
        emit(
            "pause_changed",
            near_sdk::serde_json::json!({ "paused": paused }),
        );
    }

    pub fn set_limits(
        &mut self,
        min_deposit: U128,
        max_withdrawal: U128,
        max_withdrawal_per_window: U128,
    ) {
        self.require_owner();
        require!(min_deposit.0 > 0, "min_deposit must be greater than zero");
        require!(
            max_withdrawal.0 > 0,
            "max_withdrawal must be greater than zero"
        );
        require!(
            max_withdrawal_per_window.0 >= max_withdrawal.0,
            "window limit must be at least max_withdrawal"
        );
        self.min_deposit = min_deposit.0;
        self.max_withdrawal = max_withdrawal.0;
        self.max_withdrawal_per_window = max_withdrawal_per_window.0;
        emit(
            "limits_changed",
            near_sdk::serde_json::json!({
                "min_deposit": min_deposit.0.to_string(),
                "max_withdrawal": max_withdrawal.0.to_string(),
                "max_withdrawal_per_window": max_withdrawal_per_window.0.to_string(),
            }),
        );
    }

    fn refresh_withdrawal_window(&mut self, now: u64) {
        if now.saturating_sub(self.withdrawal_window_started_at_ns) >= self.withdrawal_window_ns {
            self.withdrawal_window_started_at_ns = now;
            self.withdrawn_in_window = 0;
        }
    }

    fn require_not_paused(&self) {
        require!(!self.paused, "contract is paused");
    }

    fn require_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn require_tee_worker(&self) {
        require!(
            env::predecessor_account_id() == self.tee_worker_id,
            "TEE worker only"
        );
    }
}

fn withdrawal_view(withdrawal_id: String, record: WithdrawalRecord) -> WithdrawalView {
    WithdrawalView {
        withdrawal_id,
        recipient_id: record.recipient_id,
        amount: U128(record.amount),
        expiry_ns: U64(record.expiry_ns),
        ledger_root: record.ledger_root,
        status: record.status.as_str().to_owned(),
        attempts: record.attempts,
        window_started_at_ns: U64(record.window_started_at_ns),
        started_at_ns: U64(record.started_at_ns),
        completed_at_ns: U64(record.completed_at_ns),
    }
}

fn require_hash(value: &str, field: &str) {
    require!(
        value.len() == MAX_HASH_LENGTH
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        format!("{field} must be a lowercase SHA-256 hash")
    );
}

fn deposit_key(depositor_id: &AccountId, commitment: &str) -> String {
    format!("{depositor_id}:{commitment}")
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "airotc",
            "version": "1.0.0",
            "event": event,
            "data": data,
        })
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::{NearToken, PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};
    use sha2::{Digest, Sha256};

    #[derive(near_sdk::serde::Deserialize, near_sdk::serde::Serialize)]
    #[serde(crate = "near_sdk::serde", rename_all = "camelCase")]
    struct ProtocolTerms {
        version: u8,
        ticket_id: String,
        buyer_id: String,
        seller_id: String,
        asset_description_hash: String,
        currency: String,
        price_atomic: String,
        buyer_collateral_atomic: String,
        seller_collateral_atomic: String,
        funding_deadline_ns: String,
        delivery_deadline_ns: String,
        confirmation_deadline_ns: String,
        seller_timeout_rule: String,
        buyer_timeout_rule: String,
        nonce: String,
        expires_at_ns: String,
    }

    const ROOT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const MEASUREMENT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const ENCRYPTION_KEY_HASH: &str =
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const WITHDRAWAL: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const WITHDRAWAL_TWO: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const COMMITMENT: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    fn context(predecessor: AccountId, timestamp: u64, deposit: u128) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(accounts(5))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .block_timestamp(timestamp)
            .attached_deposit(NearToken::from_yoctonear(deposit));
        builder
    }

    fn contract() -> PrivatePool {
        testing_env!(context(accounts(0), 1_000, 0).build());
        PrivatePool::new(PoolInitConfig {
            owner_id: accounts(0),
            tee_worker_id: accounts(1),
            tee_measurement_hash: MEASUREMENT.to_owned(),
            tee_encryption_key_hash: ENCRYPTION_KEY_HASH.to_owned(),
            min_deposit: U128(1),
            max_withdrawal: U128(10u128.pow(28)),
            max_withdrawal_per_window: U128(10u128.pow(29)),
            withdrawal_window_ns: U64(60 * 1_000_000_000),
            rotation_delay_ns: U64(1_000),
        })
    }

    fn deposit(contract: &mut PrivatePool) -> u128 {
        testing_env!(context(accounts(2), 2_000, 10u128.pow(24)).build());
        contract.deposit(COMMITMENT.to_owned()).0
    }

    #[test]
    fn deposit_records_net_credit_and_liability() {
        let mut contract = contract();
        let amount = deposit(&mut contract);
        assert!(amount > 0);
        assert!(amount < 10u128.pow(24));
        let view = contract
            .get_deposit(accounts(2), COMMITMENT.to_owned())
            .unwrap();
        assert_eq!(view.amount.0, amount);
        assert_eq!(contract.get_config().pool_liability.0, amount);

        testing_env!(context(accounts(3), 2_500, 10u128.pow(24)).build());
        let second_amount = contract.deposit(COMMITMENT.to_owned()).0;
        let second_view = contract
            .get_deposit(accounts(3), COMMITMENT.to_owned())
            .unwrap();
        assert_eq!(second_view.depositor_id, accounts(3));
        assert_eq!(second_view.amount.0, second_amount);
        assert_eq!(
            contract.get_config().pool_liability.0,
            amount + second_amount
        );
    }

    #[test]
    fn rust_tooling_matches_the_shared_protocol_vector() {
        let vector: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(include_str!(
            "../../shared-types/fixtures/protocol-v1.json"
        ))
        .unwrap();
        let terms: ProtocolTerms =
            near_sdk::serde_json::from_value(vector["terms"].clone()).unwrap();
        let canonical = near_sdk::serde_json::to_string(&terms).unwrap();
        assert_eq!(canonical, vector["canonicalTerms"].as_str().unwrap());

        let mut hasher = Sha256::new();
        hasher.update(b"airotc:private-terms:v1\0");
        hasher.update(canonical.as_bytes());
        let actual = hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(actual, vector["termsHash"].as_str().unwrap());
    }

    #[test]
    #[should_panic(expected = "TEE worker only")]
    fn only_registered_worker_can_anchor() {
        let mut contract = contract();
        testing_env!(context(accounts(3), 2_000, 0).build());
        contract.anchor_ledger_root(ROOT.to_owned(), U64(1));
    }

    #[test]
    #[should_panic(expected = "TEE worker only")]
    fn only_registered_worker_can_withdraw() {
        let mut contract = contract();
        testing_env!(context(accounts(3), 3_000, 0).build());
        let _ = contract.withdraw(
            WITHDRAWAL.to_owned(),
            accounts(3),
            U128(1),
            U64(4_000),
            ROOT.to_owned(),
        );
    }

    #[test]
    fn anchoring_the_same_root_and_sequence_is_idempotent() {
        let mut contract = contract();
        testing_env!(context(accounts(1), 2_000, 0).build());
        contract.anchor_ledger_root(ROOT.to_owned(), U64(1));
        contract.anchor_ledger_root(ROOT.to_owned(), U64(1));
        assert_eq!(contract.get_config().latest_ledger_sequence.0, 1);
    }

    #[test]
    fn withdrawal_success_is_final_and_replay_safe() {
        let mut contract = contract();
        let deposited = deposit(&mut contract);
        testing_env!(context(accounts(1), 3_000, 0).build());
        contract.anchor_ledger_root(ROOT.to_owned(), U64(1));
        let _ = contract.withdraw(
            WITHDRAWAL.to_owned(),
            accounts(3),
            U128(deposited / 2),
            U64(4_000),
            ROOT.to_owned(),
        );

        testing_env!(
            context(accounts(5), 3_500, 0).build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Successful(vec![])],
        );
        assert!(contract.on_withdraw_complete(WITHDRAWAL.to_owned()));
        assert!(contract.is_withdrawal_finalized(WITHDRAWAL.to_owned()));

        testing_env!(context(accounts(1), 3_600, 0).build());
        let replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.withdraw(
                WITHDRAWAL.to_owned(),
                accounts(3),
                U128(deposited / 2),
                U64(4_000),
                ROOT.to_owned(),
            );
        }));
        assert!(replay.is_err());
    }

    #[test]
    fn failed_transfer_restores_liability_and_allows_exact_retry() {
        let mut contract = contract();
        let deposited = deposit(&mut contract);
        testing_env!(context(accounts(1), 3_000, 0).build());
        contract.anchor_ledger_root(ROOT.to_owned(), U64(1));
        let _ = contract.withdraw(
            WITHDRAWAL.to_owned(),
            accounts(3),
            U128(deposited / 2),
            U64(10_000),
            ROOT.to_owned(),
        );

        testing_env!(
            context(accounts(5), 3_500, 0).build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        assert!(!contract.on_withdraw_complete(WITHDRAWAL.to_owned()));
        assert_eq!(contract.get_config().pool_liability.0, deposited);

        testing_env!(context(accounts(1), 3_600, 0).build());
        let changed_expiry = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.withdraw(
                WITHDRAWAL.to_owned(),
                accounts(3),
                U128(deposited / 2),
                U64(11_000),
                ROOT.to_owned(),
            );
        }));
        assert!(changed_expiry.is_err());
        let _ = contract.withdraw(
            WITHDRAWAL.to_owned(),
            accounts(3),
            U128(deposited / 2),
            U64(10_000),
            ROOT.to_owned(),
        );
        let view = contract.get_withdrawal(WITHDRAWAL.to_owned()).unwrap();
        assert_eq!(view.status, "PENDING");
        assert_eq!(view.attempts, 2);
    }

    #[test]
    fn expired_and_excessive_withdrawals_are_rejected() {
        let mut contract = contract();
        let deposited = deposit(&mut contract);
        testing_env!(context(accounts(1), 3_000, 0).build());
        contract.anchor_ledger_root(ROOT.to_owned(), U64(1));

        let expired = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.withdraw(
                WITHDRAWAL.to_owned(),
                accounts(3),
                U128(1),
                U64(3_000),
                ROOT.to_owned(),
            );
        }));
        assert!(expired.is_err());

        testing_env!(context(accounts(0), 3_000, 0).build());
        contract.set_limits(U128(1), U128(deposited / 2), U128(deposited));
        testing_env!(context(accounts(1), 3_000, 0).build());
        let excessive = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.withdraw(
                WITHDRAWAL.to_owned(),
                accounts(3),
                U128(deposited / 2 + 1),
                U64(4_000),
                ROOT.to_owned(),
            );
        }));
        assert!(excessive.is_err());
    }

    #[test]
    fn withdrawal_window_rate_limit_is_enforced() {
        let mut contract = contract();
        let deposited = deposit(&mut contract);
        testing_env!(context(accounts(0), 2_500, 0).build());
        contract.set_limits(U128(1), U128(deposited / 2), U128(deposited / 2));
        testing_env!(context(accounts(1), 3_000, 0).build());
        contract.anchor_ledger_root(ROOT.to_owned(), U64(1));
        let amount = deposited / 3;
        let _ = contract.withdraw(
            WITHDRAWAL.to_owned(),
            accounts(3),
            U128(amount),
            U64(4_000),
            ROOT.to_owned(),
        );
        let rate_limited = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.withdraw(
                WITHDRAWAL_TWO.to_owned(),
                accounts(4),
                U128(amount),
                U64(4_000),
                ROOT.to_owned(),
            );
        }));
        assert!(rate_limited.is_err());
    }

    #[test]
    fn failed_old_window_withdrawal_does_not_reduce_the_current_window_total() {
        let mut contract = contract();
        let deposited = deposit(&mut contract);
        let amount = deposited / 4;
        testing_env!(context(accounts(1), 3_000, 0).build());
        contract.anchor_ledger_root(ROOT.to_owned(), U64(1));
        let _ = contract.withdraw(
            WITHDRAWAL.to_owned(),
            accounts(3),
            U128(amount),
            U64(70_000_000_000),
            ROOT.to_owned(),
        );

        testing_env!(context(accounts(1), 60_000_003_000, 0).build());
        let _ = contract.withdraw(
            WITHDRAWAL_TWO.to_owned(),
            accounts(4),
            U128(amount),
            U64(70_000_000_000),
            ROOT.to_owned(),
        );
        assert_eq!(contract.get_config().withdrawn_in_window.0, amount);

        testing_env!(
            context(accounts(5), 60_000_004_000, 0).build(),
            test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![PromiseResult::Failed],
        );
        assert!(!contract.on_withdraw_complete(WITHDRAWAL.to_owned()));
        let config = contract.get_config();
        assert_eq!(config.withdrawn_in_window.0, amount);
        assert_eq!(config.pool_liability.0, deposited - amount);
    }

    #[test]
    fn worker_rotation_requires_delay() {
        let mut contract = contract();
        testing_env!(context(accounts(0), 10_000, 0).build());
        contract.propose_tee_worker(accounts(4), ROOT.to_owned(), ROOT.to_owned());

        testing_env!(context(accounts(3), 10_500, 0).build());
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.activate_tee_worker();
        }));
        assert!(early.is_err());

        testing_env!(context(accounts(3), 11_000, 0).build());
        contract.activate_tee_worker();
        let config = contract.get_config();
        assert_eq!(config.tee_worker_id, accounts(4));
        assert_eq!(config.tee_measurement_hash, ROOT);
        assert_eq!(config.tee_encryption_key_hash, ROOT);

        testing_env!(context(accounts(1), 11_001, 0).build());
        let old_worker = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.anchor_ledger_root(ROOT.to_owned(), U64(1));
        }));
        assert!(old_worker.is_err());
        testing_env!(context(accounts(4), 11_001, 0).build());
        contract.anchor_ledger_root(ROOT.to_owned(), U64(1));
    }

    #[test]
    fn emergency_recovery_is_delayed_and_keeps_the_pool_paused() {
        let mut contract = contract();
        testing_env!(context(accounts(0), 10_000, 0).build());
        contract.begin_emergency_recovery(accounts(4), ROOT.to_owned(), ROOT.to_owned());
        assert!(contract.get_config().paused);

        testing_env!(context(accounts(2), 10_001, 10u128.pow(21)).build());
        let paused_deposit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.deposit(ROOT.to_owned());
        }));
        assert!(paused_deposit.is_err());

        testing_env!(context(accounts(3), 10_001, 0).build());
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.execute_emergency_recovery();
        }));
        assert!(early.is_err());

        testing_env!(context(accounts(3), 10_000 + EMERGENCY_RECOVERY_DELAY_NS, 0).build());
        contract.execute_emergency_recovery();
        let config = contract.get_config();
        assert_eq!(config.tee_worker_id, accounts(4));
        assert_eq!(config.tee_measurement_hash, ROOT);
        assert_eq!(config.tee_encryption_key_hash, ROOT);
        assert!(config.pending_recovery.is_none());
        assert!(config.paused);
    }
}
