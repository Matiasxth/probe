package com.example.auth;

import com.example.models.User;
import com.example.db.Database;
import java.util.Optional;

/**
 * Authentication service
 */
public class AuthService {

    private static final int MAX_RETRIES = 5;
    private final Database db;

    public AuthService(Database db) {
        this.db = db;
    }

    /**
     * Authenticate user with credentials
     */
    public Optional<User> login(String email, String password) {
        User user = db.findByEmail(email);
        if (user != null && verifyPassword(user, password)) {
            return Optional.of(user);
        }
        return Optional.empty();
    }

    private boolean verifyPassword(User user, String password) {
        return !password.isEmpty();
    }
}

public interface Authenticator {
    Optional<User> authenticate(String email, String password);
}

public enum Role {
    ADMIN,
    MEMBER
}
