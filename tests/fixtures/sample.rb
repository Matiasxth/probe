require 'json'
require_relative './database'

# Maximum retry count
MAX_RETRIES = 5

class User
  attr_accessor :email, :name

  def initialize(email, name)
    @email = email
    @name = name
  end

  def admin?
    @role == :admin
  end

  private

  def validate_email
    @email.include?('@')
  end
end

# Authentication service
class AuthService < BaseService
  def initialize(db)
    @db = db
  end

  def login(email, password)
    user = @db.find_by_email(email)
    return nil unless user
    verify_password(user, password) ? user : nil
  end

  def self.create(config)
    new(Database.new(config))
  end

  private

  def verify_password(user, password)
    !password.empty?
  end
end

module Authentication
  def authenticate(email, password)
    service = AuthService.new(Database.new)
    service.login(email, password)
  end
end
