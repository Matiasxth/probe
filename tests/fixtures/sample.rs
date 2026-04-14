use std::collections::HashMap;
use crate::db::Database;
use super::utils::validate;

/// Maximum retry count
pub const MAX_RETRIES: u32 = 5;

/// Represents a user in the system
pub struct User {
    pub id: String,
    pub email: String,
    role: Role,
}

pub enum Role {
    Admin,
    Member,
}

/// Authentication trait
pub trait Authenticator {
    fn authenticate(&self, email: &str, password: &str) -> Result<User, AuthError>;
}

pub type AuthResult = Result<User, AuthError>;

impl User {
    pub fn new(id: String, email: String) -> Self {
        User { id, email, role: Role::Member }
    }

    pub fn is_admin(&self) -> bool {
        matches!(self.role, Role::Admin)
    }
}

/// Authentication service
pub struct AuthService {
    db: Database,
}

impl AuthService {
    pub fn new(db: Database) -> Self {
        AuthService { db }
    }

    /// Authenticate user with credentials
    pub fn login(&self, email: &str, password: &str) -> AuthResult {
        let user = self.db.find_by_email(email)?;
        if verify_password(&user, password) {
            Ok(user)
        } else {
            Err(AuthError::InvalidPassword)
        }
    }
}

fn verify_password(user: &User, password: &str) -> bool {
    !password.is_empty()
}

pub struct AuthError;

impl AuthError {
    pub const InvalidPassword: AuthError = AuthError;
}
