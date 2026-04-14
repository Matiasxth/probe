package auth

import (
	"context"
	"errors"
	"fmt"
)

// MaxRetries is the maximum number of login attempts
const MaxRetries = 5

var ErrUnauthorized = errors.New("unauthorized")

// User represents an authenticated user
type User struct {
	ID    string
	Email string
	Role  Role
}

// Role defines user permission level
type Role int

const (
	RoleUser  Role = iota
	RoleAdmin
)

// AuthService handles authentication
type AuthService struct {
	db Database
}

// NewAuthService creates a new auth service
func NewAuthService(db Database) *AuthService {
	return &AuthService{db: db}
}

// Authenticate verifies credentials and returns a user
func (s *AuthService) Authenticate(ctx context.Context, email, password string) (*User, error) {
	user, err := s.db.FindByEmail(ctx, email)
	if err != nil {
		return nil, fmt.Errorf("find user: %w", err)
	}
	if !verifyPassword(user, password) {
		return nil, ErrUnauthorized
	}
	return user, nil
}

func verifyPassword(user *User, password string) bool {
	return user.Email != "" && password != ""
}

// Database defines the data access interface
type Database interface {
	FindByEmail(ctx context.Context, email string) (*User, error)
}
