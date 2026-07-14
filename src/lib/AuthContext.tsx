import React, { createContext, useContext, useState, useEffect } from 'react';
import { User } from './auth';
import { supabase } from '../supabaseClient';

interface AuthContextType {
  currentUser: User | null;
  login: (id: string, password: string) => Promise<boolean>;
  logout: () => void;
  isLoading: boolean;
  addUser: (user: User) => Promise<boolean>;
  deleteUser: (userId: string) => Promise<boolean>;
  updateUserPassword: (userId: string, newPassword: string) => Promise<boolean>;
  updateUserPermissions: (userId: string, allowedMenus: string[]) => Promise<boolean>;
  users: User[];
  refreshUsers: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Initial users fetch
  const fetchUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('*');

      if (error) {
        console.error('Fetch users error:', error);
        return;
      }
      
      if (data) {
        const mappedUsers: User[] = data.map(u => ({
          id: u.id,
          password: u.password,
          name: u.name,
          role: u.role,
          allowedMenus: u.allowedMenus || []
        }));
        setUsers(mappedUsers);

        // Bootstrap Admin if not exists in DB
        const envAdminId = String(import.meta.env.VITE_ADMIN_ID || 'admin').trim().toLowerCase();
        const adminInDb = mappedUsers.find(u => u.id === envAdminId);
        
        if (!adminInDb) {
          const envAdminPw = String(import.meta.env.VITE_ADMIN_PASSWORD || '1234').trim();
          const { error: insertError } = await supabase.from('users').insert([{
            id: envAdminId,
            password: envAdminPw,
            name: '관리자',
            role: 'ADMIN',
            allowedMenus: ['product', 'sales', 'user-management']
          }]);
          
          if (!insertError) {
            // Re-fetch once to get the fresh list with admin
            const { data: reData } = await supabase.from('users').select('*');
            if (reData) {
              setUsers(reData.map(u => ({
                id: u.id,
                password: u.password,
                name: u.name,
                role: u.role,
                allowedMenus: u.allowedMenus || []
              })));
            }
          }
        }
      }
    } catch (err) {
      console.error('Error in fetchUsers:', err);
    }
  };

  const logout = () => {
    setCurrentUser(null);
    localStorage.removeItem('currentUser');
    if (window.location.pathname !== '/') {
      window.location.href = '/'; // Force redirect to login
    }
  };

  // Session check logic (Unified for Init and Fetch Interceptor)
  const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours precisely

  const checkSession = () => {
    const savedUser = localStorage.getItem('currentUser');
    if (savedUser) {
      try {
        const user: User = JSON.parse(savedUser);
        if (!user.loginAt || (Date.now() - user.loginAt > SESSION_TTL)) {
          console.warn('Session expired (24h). Logging out.');
          logout();
          return false;
        }
      } catch (e) {
        logout();
        return false;
      }
    }
    return true;
  };

  useEffect(() => {
    const init = async () => {
      setIsLoading(true);

      // Clean up potentially expired or invalid Supabase Auth sessions to prevent 401 JWT expired errors on boots
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
            const rawToken = localStorage.getItem(key);
            if (rawToken) {
              const parsed = JSON.parse(rawToken);
              // If the token is expired or expires_at is in the past
              if (parsed.expires_at && parsed.expires_at * 1000 < Date.now()) {
                console.warn('Expired Supabase JWT detected on startup. Evicting to fallback to anon key.');
                keysToRemove.push(key);
              }
            }
          }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        if (keysToRemove.length > 0) {
          await supabase.auth.signOut().catch(() => {});
        }
      } catch (e) {
        console.warn('Silent session validation check bypassed:', e);
      }

      await fetchUsers();
      checkSession();
      setIsLoading(false);
    };
    init();

    // Patch global fetch for "API Interceptor" requirement safely using Object.defineProperty to support read-only/getter-only window environments
    const originalFetch = window.fetch;
    const customFetch = async (...args: Parameters<typeof originalFetch>) => {
      // Check session before any API call
      checkSession();
      const response = await originalFetch(...args);
      
      // Force logout on 401 Unauthorized from server
      if (response.status === 401) {
        console.warn('API 401 Unauthorized detected. Purging invalid/expired Supabase auth token to allow anonymous fallback.');
        try {
          const keysToRemove: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
              keysToRemove.push(key);
            }
          }
          keysToRemove.forEach(k => localStorage.removeItem(k));
          supabase.auth.signOut().catch(() => {});
        } catch (e) {
          console.error('Failed to cleanup expired session in fetch interceptor:', e);
        }
      }
      return response;
    };

    try {
      Object.defineProperty(window, 'fetch', {
        value: customFetch,
        configurable: true,
        writable: true,
        enumerable: true
      });
    } catch (e) {
      console.error('Failed to intercept window.fetch using Object.defineProperty, falling back to direct assignment:', e);
      try {
        window.fetch = customFetch;
      } catch (err) {
        console.error('Failed to patch fetch entirely:', err);
      }
    }

    // Periodic check every 1 minute
    const interval = setInterval(checkSession, 60000);
    return () => {
      clearInterval(interval);
      try {
        Object.defineProperty(window, 'fetch', {
          value: originalFetch,
          configurable: true,
          writable: true,
          enumerable: true
        });
      } catch (e) {
        try {
          window.fetch = originalFetch; // Fallback cleanup
        } catch (err) {}
      }
    };
  }, []);

  const login = async (id: string, password: string): Promise<boolean> => {
    const inputId = String(id || '').trim().toLowerCase();
    const inputPw = String(password || '').trim();

    try {
      // 1. Check local environment admin fallback first
      const envAdminId = String(import.meta.env.VITE_ADMIN_ID || 'admin').trim().toLowerCase();
      const envAdminPw = String(import.meta.env.VITE_ADMIN_PASSWORD || '1234').trim();

      if (inputId === envAdminId && inputPw === envAdminPw) {
        const adminUser: User = {
          id: envAdminId,
          name: 'SYSTEM ADMIN',
          role: 'ADMIN',
          allowedMenus: ['all'],
          loginAt: Date.now()
        };
        setCurrentUser(adminUser);
        localStorage.setItem('currentUser', JSON.stringify(adminUser));
        return true;
      }

      // 2. Database query fallback for regular/other users
      if (!supabase) {
        return false;
      }

      const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', inputId);

      // If database is not ready or has table missing issue, we do NOT crash or fail admin
      if (error) {
        console.warn('Database user search failed, bypassing or relying on local credentials:', error.message);
        return false;
      }

      if (!data || data.length === 0) {
        return false;
      }

      const userRecord = data[0];
      if (userRecord.password !== inputPw) {
        return false;
      }

      const user: User = {
        id: userRecord.id,
        name: userRecord.name,
        role: userRecord.role,
        allowedMenus: userRecord.allowedMenus || [],
        loginAt: Date.now()
      };
      setCurrentUser(user);
      localStorage.setItem('currentUser', JSON.stringify(user));
      return true;
    } catch (err: any) {
      console.warn('Login flow caught handling error safely:', err);
    }
    return false;
  };

  const addUser = async (user: User): Promise<boolean> => {
    try {
      // payload strictly containing only the 5 required fields to avoid DB schema mismatches
      const newUser = {
        id: user.id.trim().toLowerCase(),
        password: user.password?.trim() || '1234',
        name: user.name.trim(),
        role: user.role,
        allowedMenus: user.allowedMenus
      };

      const { error } = await supabase.from('users').insert([newUser]);
      
      if (error) {
        console.error("Supabase Insert Error:", error);
        return false;
      }

      await fetchUsers();
      return true;
    } catch (err) {
      console.error('Add User System Error:', err);
      return false;
    }
  };

  const deleteUser = async (userId: string): Promise<boolean> => {
    try {
      const { error } = await supabase.from('users').delete().eq('id', userId);
      if (error) throw error;
      await fetchUsers();
      return true;
    } catch (err) {
      console.error('Error deleting user:', err);
      return false;
    }
  };

  const updateUserPassword = async (userId: string, newPassword: string): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('users')
        .update({ password: newPassword.trim() })
        .eq('id', userId);
      if (error) throw error;
      await fetchUsers();
      return true;
    } catch (err) {
      console.error('Error updating password:', err);
      return false;
    }
  };

  const updateUserPermissions = async (userId: string, allowedMenus: string[]): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('users')
        .update({ allowedMenus: allowedMenus })
        .eq('id', userId);
      if (error) throw error;
      await fetchUsers();

      // Update current user session if it's them
      if (currentUser?.id === userId) {
        const updatedUser = { ...currentUser, allowedMenus };
        setCurrentUser(updatedUser);
        localStorage.setItem('currentUser', JSON.stringify(updatedUser));
      }
      return true;
    } catch (err) {
      console.error('Error updating permissions:', err);
      return false;
    }
  };

  return (
    <AuthContext.Provider value={{ 
      currentUser, login, logout, isLoading, updateUserPermissions, users,
      addUser, deleteUser, updateUserPassword,
      refreshUsers: fetchUsers
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
